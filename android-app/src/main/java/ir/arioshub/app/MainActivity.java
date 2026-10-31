package ir.arioshub.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.hardware.fingerprint.FingerprintManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.net.ssl.HttpsURLConnection;

/** Native Android lock around a normal, server-authenticated Arios session.
 * No JavaScript interface; the website never sees biometrics, keys or cookies.
 */
public final class MainActivity extends Activity {
    private static final int NAVY = Color.rgb(23, 41, 45), GOLD = Color.rgb(198, 163, 105), CREAM = Color.rgb(248, 245, 237);
    private static final int PICK_FILE = 4001, SAVE_FILE = 4002, MAX_DOWNLOAD = 24 * 1024 * 1024;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newFixedThreadPool(2);
    private FrameLayout content;
    private LinearLayout privacy;
    private TextView lockTitle, lockMessage, statusText;
    private Button unlockButton, passwordButton;
    private ProgressBar progress;
    private WebView web;
    private Typeface font;
    private BiometricVault vault;
    private CancellationSignal authentication;
    private boolean locked, visible, promptActive, webLoaded, checkingSession, enrollmentRequested, downloadInProgress, clearingAccount;
    private volatile boolean destroyed;
    private String sessionUser = "";
    private long lastSessionCheck;
    private volatile int sessionGeneration;
    private int sessionCheckId;
    private ValueCallback<Uri[]> fileCallback;
    private Uri[] pendingFileUris;
    private boolean fileResultReady, savePickerOpen;
    private Uri pendingSaveUri;
    private byte[] exportBytes;
    private String exportName, exportMime;
    private WebView printView;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(NAVY); getWindow().setNavigationBarColor(NAVY);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        vault = new BiometricVault(this);
        try { font = Typeface.createFromAsset(getAssets(), "vazirmatn.ttf"); } catch (Exception ignored) { font = Typeface.DEFAULT; }
        buildViews(); buildWebView();
        locked = vault.enabled();
        if (locked) showLock("آریوس قفل است", "برای بازکردن برنامه اثر انگشت خود را تأیید کنید.");
        else { revealWeb(); loadHome(); }
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private TextView text(String label, int size, int color) {
        TextView v = new TextView(this); v.setText(label); v.setTextSize(size); v.setTextColor(color); v.setTypeface(font); v.setGravity(Gravity.CENTER); return v;
    }
    private Button button(String label) {
        Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setTypeface(font); b.setTextColor(NAVY); b.setAllCaps(false); b.setMinHeight(dp(48)); return b;
    }
    private void buildViews() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(NAVY);
        root.setOnApplyWindowInsetsListener((v, insets) -> { v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
        LinearLayout toolbar = new LinearLayout(this); toolbar.setGravity(Gravity.CENTER_VERTICAL); toolbar.setPadding(dp(12), dp(3), dp(8), dp(3));
        TextView brand = text("آریوس", 20, GOLD); brand.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); toolbar.addView(brand, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button settings = button("قفل برنامه"); settings.setTextSize(13); settings.setTextColor(GOLD); settings.setBackgroundColor(Color.TRANSPARENT); settings.setOnClickListener(v -> showSecuritySettings()); toolbar.addView(settings);
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(54)));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(100); root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
        statusText = text("", 12, CREAM); statusText.setPadding(dp(12), dp(5), dp(12), dp(5)); statusText.setVisibility(View.GONE); root.addView(statusText);
        content = new FrameLayout(this); root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        privacy = new LinearLayout(this); privacy.setOrientation(LinearLayout.VERTICAL); privacy.setGravity(Gravity.CENTER); privacy.setPadding(dp(28), dp(24), dp(28), dp(24)); privacy.setBackgroundColor(NAVY); privacy.setClickable(true); privacy.setFocusable(true);
        ImageView logo = new ImageView(this); logo.setImageResource(R.drawable.arios_icon); logo.setScaleType(ImageView.ScaleType.FIT_CENTER); privacy.addView(logo, new LinearLayout.LayoutParams(dp(132), dp(132)));
        lockTitle = text("به آریوس خوش آمدید", 23, CREAM); privacy.addView(lockTitle, new LinearLayout.LayoutParams(-1, -2));
        lockMessage = text("", 16, CREAM); lockMessage.setLineSpacing(dp(5), 1); lockMessage.setPadding(0, dp(14), 0, dp(22)); privacy.addView(lockMessage, new LinearLayout.LayoutParams(-1, -2));
        unlockButton = button("بازکردن با اثر انگشت"); unlockButton.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GOLD)); unlockButton.setOnClickListener(v -> authenticate(false)); privacy.addView(unlockButton, new LinearLayout.LayoutParams(-1, dp(54)));
        passwordButton = button("ورود با رمز حساب"); passwordButton.setTextColor(CREAM); passwordButton.setBackgroundColor(Color.TRANSPARENT); passwordButton.setOnClickListener(v -> confirmPasswordFallback()); privacy.addView(passwordButton, new LinearLayout.LayoutParams(-1, dp(54)));
        content.addView(privacy, new FrameLayout.LayoutParams(-1, -1)); setContentView(root);
    }

    @SuppressWarnings("deprecation") private void configureWebView(WebView target) {
        WebSettings s = target.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false); s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); s.setCacheMode(WebSettings.LOAD_NO_CACHE); s.setSavePassword(false); s.setSaveFormData(false);
        s.setSafeBrowsingEnabled(true); s.setSupportMultipleWindows(true); s.setJavaScriptCanOpenWindowsAutomatically(false); s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " AriosAndroid/1");
        target.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(target, false);
        target.setBackgroundColor(CREAM); target.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
    private void buildWebView() {
        web = new WebView(this); configureWebView(web); WebView.setWebContentsDebuggingEnabled(false);
        web.setVisibility(View.INVISIBLE); content.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return handleNavigation(request.getUrl().toString(), request.hasGesture()); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return handleNavigation(url, true); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!SecurityPolicy.resource(request.getUrl().toString())) return blockedResource(); return null;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); main.post(() -> notice("ارتباط امن تأیید نشد؛ اتصال اینترنت را بررسی کنید.")); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { progress.setVisibility(View.VISIBLE); }
            @Override public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE); CookieManager.getInstance().flush();
                if (SecurityPolicy.canonical(url)) main.postDelayed(() -> checkSession(true), 1000);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) main.post(() -> notice("ارتباط برقرار نشد؛ از قفل برنامه ← تازه‌سازی صفحه دوباره امتحان کنید."));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (locked || !trustedPage()) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null); fileCallback = callback; fileResultReady = false;
                Intent choose = new Intent(Intent.ACTION_OPEN_DOCUMENT); choose.addCategory(Intent.CATEGORY_OPENABLE); choose.setType("*/*");
                String[] accepts = params.getAcceptTypes(); if (accepts != null && accepts.length > 0 && accepts.length < 20) choose.putExtra(Intent.EXTRA_MIME_TYPES, accepts);
                choose.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(choose, PICK_FILE); } catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; notice("انتخاب فایل در این گوشی در دسترس نیست."); }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, android.os.Message result) {
                if (!userGesture || locked || !trustedPage()) return false;
                WebView child = new WebView(MainActivity.this); configureWebView(child);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { handleNavigation(r.getUrl().toString(), true); v.destroy(); return true; }
                    @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { h.cancel(); }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return SecurityPolicy.resource(r.getUrl().toString()) ? null : blockedResource(); }
                    @Override public void onPageFinished(WebView v, String url) { main.postDelayed(() -> {
                        if (destroyed || locked || !"about:blank".equals(v.getUrl())) return;
                        v.evaluateJavascript("document.body ? document.body.innerText.length : 0", length -> { try { if (Integer.parseInt(length) > 20) printWebView(v); } catch (Exception ignored) {} });
                    }, 700); }
                });
                child.setWebChromeClient(new WebChromeClient());
                WebView.WebViewTransport transport = (WebView.WebViewTransport) result.obj; transport.setWebView(child); result.sendToTarget(); return true;
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, size) -> {
            if (!locked && trustedPage()) beginDownload(url, URLUtil.guessFileName(url, disposition, mime), mime);
        });
    }

    private WebResourceResponse blockedResource() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0])); }
    private boolean trustedPage() { return web != null && SecurityPolicy.canonical(web.getUrl()); }
    private boolean handleNavigation(String url, boolean gesture) {
        if (SecurityPolicy.canonical(url)) return false;
        if (SecurityPolicy.signedStorageFile(url) && !locked && trustedPage()) { beginDownload(url, null, null); return true; }
        if (gesture && SecurityPolicy.external(url) && !locked) {
            new AlertDialog.Builder(this).setTitle("بازکردن برنامهٔ دیگر").setMessage("این لینک بیرون از آریوس باز می‌شود.").setPositiveButton("باز شود", (d, which) -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException e) { notice("برنامهٔ مربوط به این لینک نصب نیست."); }
            }).setNegativeButton("انصراف", null).show();
        }
        return true;
    }
    private void loadHome() { if (!webLoaded) { webLoaded = true; web.loadUrl(SecurityPolicy.ORIGIN + "/portal/?native=android"); } }
    private void notice(String message) { if (destroyed) return; statusText.setText(message); statusText.setVisibility(View.VISIBLE); }
    private void showLock(String title, String message) {
        locked = true; web.setVisibility(View.INVISIBLE); privacy.setVisibility(View.VISIBLE); privacy.bringToFront(); lockTitle.setText(title); lockMessage.setText(message); unlockButton.setVisibility(vault.enabled() ? View.VISIBLE : View.GONE);
    }
    private void revealWeb() {
        locked = false; privacy.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); statusText.setVisibility(View.GONE); loadHome(); deliverPending();
    }

    @Override protected void onResume() {
        super.onResume(); visible = true;
        if (vault.enabled() && locked && !promptActive) main.postDelayed(() -> { if (visible && locked && !promptActive) authenticate(false); }, 200);
        else if (!locked) { deliverPending(); main.postDelayed(() -> checkSession(false), 1000); }
    }
    @Override protected void onPause() {
        if (vault.enabled()) showLock("آریوس قفل است", "برای ادامه اثر انگشت خود را تأیید کنید.");
        super.onPause();
    }
    @Override protected void onStop() {
        visible = false; if (authentication != null) authentication.cancel(); promptActive = false;
        CookieManager.getInstance().flush(); super.onStop();
    }
    @Override protected void onDestroy() {
        destroyed = true; if (authentication != null) authentication.cancel(); main.removeCallbacksAndMessages(null); network.shutdownNow();
        clearPendingFiles();
        if (web != null) { web.stopLoading(); web.destroy(); } if (printView != null) printView.destroy(); super.onDestroy();
    }
    @Override public void onBackPressed() {
        if (locked) { moveTaskToBack(true); return; }
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @SuppressWarnings("deprecation") private boolean biometricAvailable() {
        KeyguardManager keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE); if (keyguard == null || !keyguard.isDeviceSecure()) return false;
        if (Build.VERSION.SDK_INT >= 30) { BiometricManager b = getSystemService(BiometricManager.class); return b != null && b.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS; }
        FingerprintManager fingerprint = getSystemService(FingerprintManager.class); return fingerprint != null && fingerprint.isHardwareDetected() && fingerprint.hasEnrolledFingerprints();
    }
    private void authenticate(boolean enabling) {
        if (destroyed || !visible || promptActive) return;
        if (enabling && sessionUser.length() == 0) { notice("ابتدا با شماره تماس و رمز وارد حساب شوید."); return; }
        if (!biometricAvailable()) {
            if (!enabling) showLock("اثر انگشت آماده نیست", "برای ورود با رمز حساب، دکمهٔ پایین را بزنید؛ برای اثر انگشت، ابتدا آن را در تنظیمات گوشی ثبت کنید.");
            else new AlertDialog.Builder(this).setTitle("اثر انگشت گوشی").setMessage("ابتدا قفل صفحه و اثر انگشت را در تنظیمات گوشی فعال کنید.").setPositiveButton("تنظیمات گوشی", (d,w) -> openBiometricSettings()).setNegativeButton("فعلاً نه", null).show();
            return;
        }
        final Cipher cipher;
        try { cipher = enabling ? vault.prepareEnrollment() : vault.prepareUnlock(); }
        catch (Exception e) { showLock("قفل گوشی تغییر کرده است", "برای محافظت از حساب، دوباره با رمز حساب وارد شوید و اثر انگشت را فعال کنید."); unlockButton.setVisibility(View.GONE); return; }
        final int generation = sessionGeneration;
        final String enrollingUser = sessionUser;
        promptActive = true; authentication = new CancellationSignal();
        BiometricPrompt prompt = new BiometricPrompt.Builder(this).setTitle(enabling ? "فعال‌سازی ورود با اثر انگشت" : "بازکردن آریوس")
            .setSubtitle("اثر انگشت همین گوشی را تأیید کنید")
            .setDescription(enabling ? "دفعات بعد بدون نوشتن رمز وارد برنامه می‌شوید؛ گذرکلید یا حساب گوگل لازم نیست." : "اطلاعات اثر انگشت در گوشی شما می‌ماند.")
            .setNegativeButton(enabling ? "فعلاً نه" : "ورود با رمز", getMainExecutor(), (dialog, which) -> {
                if (generation != sessionGeneration || destroyed) return; promptActive = false;
                if (enabling) { vault.decline(enrollingUser); revealWeb(); } else confirmPasswordFallback();
            }).build();
        prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), authentication, getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                if (generation != sessionGeneration || destroyed) return;
                promptActive = false; authentication = null;
                if (!visible || destroyed || generation != sessionGeneration || result.getCryptoObject() == null || result.getCryptoObject().getCipher() == null) return;
                try {
                    if (enabling) vault.completeEnrollment(result.getCryptoObject().getCipher(), enrollingUser);
                    else vault.verifyUnlock(result.getCryptoObject().getCipher());
                    revealWeb(); if (enabling) notice("ورود با اثر انگشت فعال شد؛ دفعهٔ بعد فقط حسگر گوشی را تأیید کنید."); checkSession(false);
                } catch (Exception e) { showLock("تأیید دستگاه انجام نشد", "دوباره امتحان کنید یا با رمز حساب وارد شوید."); }
            }
            @Override public void onAuthenticationError(int error, CharSequence message) {
                if (generation != sessionGeneration || destroyed) return;
                promptActive = false; authentication = null; if (!visible) return;
                if (enabling) { vault.decline(enrollingUser); revealWeb(); notice("اثر انگشت فعال نشد؛ ورود با رمز حساب همچنان در دسترس است."); }
                else showLock("آریوس قفل است", "اثر انگشت تأیید نشد. دوباره امتحان کنید یا با رمز حساب وارد شوید.");
            }
            @Override public void onAuthenticationFailed() { if (!enabling && generation == sessionGeneration && !destroyed) lockMessage.setText("اثر انگشت شناسایی نشد؛ دوباره حسگر را لمس کنید."); }
        });
    }
    private void openBiometricSettings() {
        try { Intent intent = Build.VERSION.SDK_INT >= 30 ? new Intent(Settings.ACTION_BIOMETRIC_ENROLL).putExtra(Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED, BiometricManager.Authenticators.BIOMETRIC_STRONG) : new Intent(Settings.ACTION_SECURITY_SETTINGS); startActivity(intent); }
        catch (ActivityNotFoundException e) { notice("از تنظیمات خود گوشی، قفل و اثر انگشت را فعال کنید."); }
    }

    private void showSecuritySettings() {
        if (clearingAccount) return;
        if (locked) { if (vault.enabled()) authenticate(false); else confirmPasswordFallback(); return; }
        String[] choices = vault.enabled() ? new String[]{"قفل‌کردن برنامه", "خاموش‌کردن اثر انگشت و خروج", "تازه‌سازی صفحه", "چاپ صفحه", "ورود با حساب دیگر"} : new String[]{"فعال‌سازی اثر انگشت", "تازه‌سازی صفحه", "چاپ صفحه", "ورود با حساب دیگر"};
        new AlertDialog.Builder(this).setTitle("قفل برنامهٔ آریوس").setItems(choices, (dialog, which) -> {
            String chosen = choices[which];
            if (chosen.equals("قفل‌کردن برنامه")) { showLock("آریوس قفل است", "برای ادامه اثر انگشت خود را تأیید کنید."); authenticate(false); }
            else if (chosen.startsWith("فعال‌سازی")) { enrollmentRequested = true; checkSession(true); }
            else if (chosen.equals("تازه‌سازی صفحه")) web.reload();
            else if (chosen.equals("چاپ صفحه")) printWebView(web);
            else confirmPasswordFallback();
        }).setNegativeButton("بستن", null).show();
    }
    private void confirmPasswordFallback() {
        if (clearingAccount) return;
        new AlertDialog.Builder(this).setTitle("ورود با رمز حساب").setMessage("برای ورود با رمز، نشست این برنامه پاک می‌شود. سپس شماره تماس و رمز حساب خود را وارد کنید.")
            .setPositiveButton("ورود با رمز", (d,w) -> clearLocalAccount()).setNegativeButton("انصراف", null).show();
    }
    private void clearLocalAccount() {
        if (clearingAccount || destroyed) return;
        final String previousCookies = CookieManager.getInstance().getCookie(SecurityPolicy.ORIGIN);
        if (authentication != null) authentication.cancel(); promptActive = false; sessionGeneration++; sessionCheckId++; sessionUser = ""; checkingSession = false; enrollmentRequested = false; downloadInProgress = false; vault.clear();
        clearingAccount = true; final int generation = sessionGeneration;
        showLock("در حال خروج از حساب", "نشست این برنامه پاک می‌شود؛ چند لحظه صبر کنید."); passwordButton.setEnabled(false);
        clearPendingFiles();
        web.stopLoading(); web.loadUrl("about:blank"); web.clearHistory(); web.clearCache(true); WebStorage.getInstance().deleteAllData();
        final boolean[] completed = {false, previousCookies == null};
        final Runnable finish = () -> {
            if (destroyed || generation != sessionGeneration || !completed[0] || !completed[1]) return;
            clearingAccount = false; passwordButton.setEnabled(true); webLoaded = false; revealWeb();
        };
        CookieManager.getInstance().removeAllCookies(removed -> { CookieManager.getInstance().flush(); completed[0] = true; finish.run(); });
        if (previousCookies != null) network.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(SecurityPolicy.ORIGIN + "/api/logout").openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000); connection.setReadTimeout(8000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Origin", SecurityPolicy.ORIGIN);
                connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Cookie", previousCookies);
                try (OutputStream out = connection.getOutputStream()) { out.write("{}".getBytes(StandardCharsets.UTF_8)); }
                connection.getResponseCode();
            } catch (Exception ignored) {} finally {
                if (connection != null) connection.disconnect();
                main.post(() -> { completed[1] = true; finish.run(); });
            }
        });
    }

    private void checkSession(boolean mayOfferEnrollment) {
        if (destroyed || locked || !visible || checkingSession || !trustedPage()) return;
        if (!mayOfferEnrollment && System.currentTimeMillis() - lastSessionCheck < 15000) return;
        checkingSession = true; lastSessionCheck = System.currentTimeMillis(); final int generation = sessionGeneration, checkId = ++sessionCheckId;
        final String cookies = CookieManager.getInstance().getCookie(SecurityPolicy.ORIGIN);
        network.execute(() -> {
            JSONObject result = null; Map<String,List<String>> headers = null;
            try {
                HttpsURLConnection connection = (HttpsURLConnection) new URL(SecurityPolicy.ORIGIN + "/api/session").openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(15000); connection.setUseCaches(false); connection.setRequestProperty("Cache-Control", "no-store");
                if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                int responseCode = connection.getResponseCode(); headers = connection.getHeaderFields();
                if (responseCode == 200) result = new JSONObject(new String(readBounded(connection.getInputStream(), 98304), StandardCharsets.UTF_8));
                else if (responseCode == 401 || responseCode == 403) result = new JSONObject().put("user", JSONObject.NULL);
                connection.disconnect();
            } catch (Exception ignored) {}
            final JSONObject response = result; final Map<String,List<String>> responseHeaders = headers;
            main.post(() -> {
                if (destroyed || generation != sessionGeneration || checkId != sessionCheckId) return; checkingSession = false;
                if (response == null) { if (enrollmentRequested) { enrollmentRequested = false; notice("برای فعال‌سازی اثر انگشت، اتصال اینترنت و ورود به حساب باید تأیید شود؛ دوباره امتحان کنید."); } return; }
                applySessionCookies(responseHeaders, () -> acceptSession(response, mayOfferEnrollment, generation));
            });
        });
    }

    private void applySessionCookies(Map<String,List<String>> headers, Runnable completed) {
        java.util.ArrayList<String> values = new java.util.ArrayList<>();
        if (headers != null) for (Map.Entry<String,List<String>> header : headers.entrySet()) if (header.getKey() != null && header.getKey().equalsIgnoreCase("Set-Cookie") && header.getValue() != null) values.addAll(header.getValue());
        if (values.isEmpty()) { completed.run(); return; }
        final int[] remaining = {values.size()};
        for (String value : values) CookieManager.getInstance().setCookie(SecurityPolicy.ORIGIN, value, applied -> {
            remaining[0]--; if (remaining[0] == 0) { CookieManager.getInstance().flush(); completed.run(); }
        });
    }
    private void acceptSession(JSONObject response, boolean offer, int generation) {
        if (destroyed || generation != sessionGeneration) return;
        JSONObject user = response.optJSONObject("user");
        if (user == null || user.optString("id").length() == 0) {
            boolean hadAccount = sessionUser.length() > 0 || vault.enabled(); sessionUser = "";
            if (enrollmentRequested) { enrollmentRequested = false; notice("ابتدا با شماره تماس و رمز وارد حساب شوید."); }
            if (hadAccount) clearLocalAccount(); return;
        }
        if (response.optBoolean("passwordChangeRequired") || user.optBoolean("passwordChangeRequired")) {
            sessionUser = ""; enrollmentRequested = false; if (vault.enabled()) vault.clear();
            if (trustedPage() && web.getUrl().contains("/portal/")) web.loadUrl(SecurityPolicy.ORIGIN + "/login/team?change=password");
            return;
        }
        String id = user.optString("id");
        if (sessionUser.length() > 0 && !sessionUser.equals(id)) { sessionGeneration++; downloadInProgress = false; clearPendingFiles(); }
        if (vault.enabled() && !vault.owner().equals(BiometricVault.digest(id))) vault.clear();
        sessionUser = id;
        boolean explicit = enrollmentRequested; enrollmentRequested = false;
        if (!vault.enabled() && !locked && visible && (explicit || (offer && !vault.declined(id) && biometricAvailable()))) authenticate(true);
    }

    private static byte[] readBounded(InputStream stream, int max) throws Exception {
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int total = 0, size;
            while ((size = in.read(buffer)) != -1) { total += size; if (total > max) throw new IllegalStateException("File too large"); out.write(buffer, 0, size); } return out.toByteArray();
        }
    }
    private void beginDownload(String url, String name, String mime) {
        if (url != null && url.startsWith("blob:" + SecurityPolicy.ORIGIN + "/")) { captureBlob(url, name, mime); return; }
        if (!SecurityPolicy.signedStorageFile(url) && !SecurityPolicy.canonical(url)) { notice("دریافت این فایل از داخل برنامه مجاز نیست."); return; }
        if (exportBytes != null || downloadInProgress) { notice("ابتدا ذخیرهٔ فایل قبلی را کامل کنید."); return; }
        final int generation = sessionGeneration; downloadInProgress = true;
        notice("در حال دریافت فایل…"); final String cookies = SecurityPolicy.canonical(url) ? CookieManager.getInstance().getCookie(SecurityPolicy.ORIGIN) : null;
        network.execute(() -> {
            try {
                HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection(); c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setUseCaches(false);
                if (cookies != null) c.setRequestProperty("Cookie", cookies);
                if (c.getResponseCode() != 200 || c.getContentLengthLong() > MAX_DOWNLOAD) throw new IllegalStateException("Download failed");
                String responseMime = c.getContentType(), responseName = URLUtil.guessFileName(url, c.getHeaderField("Content-Disposition"), responseMime);
                byte[] bytes = readBounded(c.getInputStream(), MAX_DOWNLOAD); c.disconnect();
                main.post(() -> { if (destroyed || generation != sessionGeneration) { java.util.Arrays.fill(bytes, (byte)0); return; } downloadInProgress = false; queueExport(bytes, name == null ? responseName : name, mime == null ? responseMime : mime); });
            } catch (Exception e) { main.post(() -> { if (destroyed || generation != sessionGeneration) return; downloadInProgress = false; notice("فایل دریافت نشد؛ دوباره تلاش کنید."); }); }
        });
    }
    private void queueExport(byte[] bytes, String name, String mime) {
        if (destroyed) return; exportBytes = bytes; exportName = SecurityPolicy.fileName(name); exportMime = mime != null && mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? mime : "application/octet-stream";
        if (!locked && visible) requestSaveFile();
    }
    private void requestSaveFile() {
        if (exportBytes == null || savePickerOpen) return;
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT); save.addCategory(Intent.CATEGORY_OPENABLE); save.setType(exportMime); save.putExtra(Intent.EXTRA_TITLE, exportName);
        try { savePickerOpen = true; startActivityForResult(save, SAVE_FILE); } catch (ActivityNotFoundException e) { savePickerOpen = false; exportBytes = null; notice("ذخیرهٔ فایل در این گوشی در دسترس نیست."); }
    }
    private void captureBlob(String url, String name, String mime) {
        if (!trustedPage() || locked || exportBytes != null || downloadInProgress) return;
        final int generation = sessionGeneration; downloadInProgress = true;
        final String key = "__arios_export_" + UUID.randomUUID().toString().replace("-", "");
        String script = "(function(){var k=" + JSONObject.quote(key) + ";window[k]={status:'pending'};fetch(" + JSONObject.quote(url) + ").then(function(r){return r.blob()}).then(function(b){if(b.size>" + MAX_DOWNLOAD + ")throw Error();var f=new FileReader();f.onload=function(){window[k]={status:'ready',size:b.size,type:b.type,data:String(f.result).split(',')[1]}};f.onerror=function(){window[k]={status:'failed'}};f.readAsDataURL(b)}).catch(function(){window[k]={status:'failed'}});return true})()";
        web.evaluateJavascript(script, ignored -> pollBlob(key, name, mime, 0, generation));
    }
    private String decodeJsString(String value) throws Exception { Object parsed = new JSONTokener(value).nextValue(); return parsed instanceof String ? (String) parsed : ""; }
    private void pollBlob(String key, String name, String mime, int attempt, int generation) {
        if (destroyed || generation != sessionGeneration) return;
        if (!trustedPage() || attempt > 120) { downloadInProgress = false; deleteBlob(key); notice("آماده‌سازی فایل انجام نشد."); return; }
        web.evaluateJavascript("(function(){var o=window[" + JSONObject.quote(key) + "];return JSON.stringify(o?{status:o.status,size:o.size,type:o.type,length:o.data?o.data.length:0}:{status:'failed'})})()", raw -> {
            if (destroyed || generation != sessionGeneration) return;
            try {
                JSONObject info = new JSONObject(decodeJsString(raw)); String state = info.optString("status");
                if (state.equals("pending")) { main.postDelayed(() -> pollBlob(key, name, mime, attempt + 1, generation), 100); return; }
                if (!state.equals("ready") || info.optInt("size", -1) < 0 || info.optInt("size") > MAX_DOWNLOAD || info.optInt("length") > (MAX_DOWNLOAD * 4 / 3 + 8)) throw new IllegalStateException();
                readBlobChunk(key, name, mime == null ? info.optString("type") : mime, info.optInt("size"), info.optInt("length"), 0, new ByteArrayOutputStream(), generation);
            } catch (Exception e) { downloadInProgress = false; deleteBlob(key); notice("فایل برای ذخیره آماده نشد."); }
        });
    }
    private void readBlobChunk(String key, String name, String mime, int size, int length, int offset, ByteArrayOutputStream out, int generation) {
        if (destroyed || generation != sessionGeneration) return;
        if (!trustedPage()) { downloadInProgress = false; deleteBlob(key); return; }
        if (offset >= length) { downloadInProgress = false; deleteBlob(key); if (out.size() != size) { notice("فایل کامل دریافت نشد."); return; } queueExport(out.toByteArray(), name, mime); return; }
        int end = Math.min(length, offset + 32768);
        web.evaluateJavascript("((window[" + JSONObject.quote(key) + "]||{}).data||'').slice(" + offset + "," + end + ")", raw -> {
            if (destroyed || generation != sessionGeneration) return;
            try { byte[] chunk = android.util.Base64.decode(decodeJsString(raw), android.util.Base64.DEFAULT); if (out.size() + chunk.length > MAX_DOWNLOAD) throw new IllegalStateException(); out.write(chunk); readBlobChunk(key, name, mime, size, length, end, out, generation); }
            catch (Exception e) { downloadInProgress = false; deleteBlob(key); notice("دریافت فایل کامل نشد."); }
        });
    }
    private void deleteBlob(String key) { if (!destroyed && web != null) web.evaluateJavascript("delete window[" + JSONObject.quote(key) + "]", null); }
    private void clearPendingFiles() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        pendingFileUris = null; fileResultReady = false; pendingSaveUri = null; savePickerOpen = false;
        if (exportBytes != null) java.util.Arrays.fill(exportBytes, (byte)0); exportBytes = null;
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent result) {
        super.onActivityResult(requestCode, resultCode, result);
        if (requestCode == PICK_FILE) {
            pendingFileUris = null; fileResultReady = true;
            if (resultCode == RESULT_OK && result != null) {
                if (result.getClipData() != null) { int n = Math.min(20, result.getClipData().getItemCount()); pendingFileUris = new Uri[n]; for (int i=0;i<n;i++) pendingFileUris[i]=result.getClipData().getItemAt(i).getUri(); }
                else if (result.getData() != null) pendingFileUris = new Uri[]{result.getData()};
            }
            if (!locked) deliverPending();
        } else if (requestCode == SAVE_FILE) {
            savePickerOpen = false;
            pendingSaveUri = resultCode == RESULT_OK && result != null ? result.getData() : null;
            if (pendingSaveUri == null) exportBytes = null; else if (!locked) deliverPending();
        }
    }
    private void deliverPending() {
        if (locked || destroyed || !visible) return;
        if (fileCallback != null && fileResultReady) {
            Uri[] uris = pendingFileUris; pendingFileUris = null; fileResultReady = false; boolean safe = trustedPage() && uris != null; if (uris != null) for (Uri uri : uris) safe &= uri != null && "content".equals(uri.getScheme());
            fileCallback.onReceiveValue(safe ? uris : null); fileCallback = null;
        }
        if (pendingSaveUri != null && exportBytes != null) {
            final Uri uri = pendingSaveUri; final byte[] bytes = exportBytes; final int generation = sessionGeneration; pendingSaveUri = null; exportBytes = null;
            if (!"content".equals(uri.getScheme())) { notice("محل ذخیره معتبر نیست."); return; }
            network.execute(() -> { try { if (generation != sessionGeneration || destroyed) return; try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) { if (output == null || generation != sessionGeneration || destroyed) throw new IllegalStateException(); output.write(bytes); main.post(() -> { if (generation == sessionGeneration && !destroyed) notice("فایل ذخیره شد."); }); } } catch (Exception e) { main.post(() -> { if (generation == sessionGeneration && !destroyed) notice("ذخیرهٔ فایل انجام نشد."); }); } finally { java.util.Arrays.fill(bytes, (byte)0); } });
        } else if (exportBytes != null && pendingSaveUri == null && !savePickerOpen) requestSaveFile();
    }
    private void printWebView(WebView target) {
        if (locked || destroyed) return;
        if (target != web) printView = target;
        android.print.PrintManager manager = (android.print.PrintManager) getSystemService(PRINT_SERVICE);
        if (manager != null) manager.print("Arios-document", target.createPrintDocumentAdapter("Arios-document"), new PrintAttributes.Builder().build());
    }
}
