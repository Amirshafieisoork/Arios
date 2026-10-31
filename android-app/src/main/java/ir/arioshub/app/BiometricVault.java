package ir.arioshub.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Per-use AndroidKeyStore CryptoObject; no passwords or session tokens stored here. */
public final class BiometricVault {
    private static final String ALIAS = "ir.arioshub.app.biometric-unlock.v1";
    private final SharedPreferences preferences;
    public BiometricVault(Context context) { preferences = context.getSharedPreferences("arios-local-lock", Context.MODE_PRIVATE); }
    public boolean enabled() { return preferences.getBoolean("enabled", false) && preferences.contains("ciphertext"); }
    public String owner() { return preferences.getString("owner", ""); }
    public boolean declined(String userId) { return digest(userId).equals(preferences.getString("declined", "")); }
    public void decline(String userId) { preferences.edit().putString("declined", digest(userId)).apply(); }
    public static String digest(String value) {
        try { byte[] data = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); return Base64.encodeToString(data, Base64.NO_WRAP); }
        catch (Exception e) { throw new IllegalStateException("Device cryptography unavailable"); }
    }
    public Cipher prepareEnrollment() throws Exception {
        clear();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        else spec.setUserAuthenticationValidityDurationSeconds(-1);
        generator.init(spec.build());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, generator.generateKey()); return cipher;
    }
    public void completeEnrollment(Cipher cipher, String userId) throws Exception {
        byte[] proof = new byte[32]; new SecureRandom().nextBytes(proof);
        try {
            byte[] encrypted = cipher.doFinal(proof);
            String proofDigest = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(proof), Base64.NO_WRAP);
            boolean saved = preferences.edit().putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).putString("proofDigest", proofDigest)
                .putString("owner", digest(userId)).putBoolean("enabled", true).remove("declined").commit();
            if (!saved) { clear(); throw new IllegalStateException("Device lock could not be saved"); }
        } finally { java.util.Arrays.fill(proof, (byte) 0); }
    }
    public Cipher prepareUnlock() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        SecretKey key = (SecretKey) store.getKey(ALIAS, null);
        if (key == null) throw new IllegalStateException("Device lock was changed");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP))); return cipher;
    }
    public void verifyUnlock(Cipher cipher) throws Exception {
        byte[] proof = cipher.doFinal(Base64.decode(preferences.getString("ciphertext", ""), Base64.NO_WRAP));
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(proof);
        byte[] expected = Base64.decode(preferences.getString("proofDigest", ""), Base64.NO_WRAP);
        boolean valid = MessageDigest.isEqual(digest, expected); java.util.Arrays.fill(proof, (byte) 0);
        if (!valid) throw new IllegalStateException("Device verification failed");
    }
    public void clear() {
        preferences.edit().clear().commit();
        try { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS); } catch (Exception ignored) {}
    }
}
