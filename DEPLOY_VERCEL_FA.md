# استقرار پروژهٔ واقعی آریوس روی Vercel

این راهنما برای همین سورس آریوس است: صفحه‌های HTML/CSS و JavaScript در `web/`، پرتال در `public/`، تابع Node در `api/index.mjs`، لایهٔ API در `backend/bff.mjs` و backend مستقل Supabase در `supabase/functions/arios-api/`.

این پروژه Next.js یا Vite نیست. `server.mjs` سرور قدیمی مستقل Node/SQLite است؛ Vercel آن را به عنوان وب‌سرور دائمی اجرا نمی‌کند. نقطهٔ ورود API در Vercel، تابع پیش‌فرض `api/index.mjs` است.

## Import مخزن

مخزن مقصد: https://github.com/Amirshafieisoork/Arios

در Vercel، حساب یا تیم خودتان را انتخاب و همین مخزن را Import کنید. تنظیمات زیر از `package.json`، `vercel.json` و `scripts/build-vercel.mjs` استخراج شده‌اند:

| تنظیم | مقدار |
| --- | --- |
| Production Branch | `main` |
| Root Directory | ریشهٔ مخزن: `./`؛ پوشهٔ `source` را انتخاب نکنید |
| Framework Preset | `Other`؛ مقدار فایل تنظیمات `null` است |
| Node.js Version | `24.x` |
| Install Command | `npm ci` |
| Build Command | `npm run build:vercel` |
| Output Directory | `dist-site` |
| Start Command | لازم نیست؛ API یک Vercel Function است |

دستور عمومی `npm run build` به Worker قدیمی Sites مربوط است. برای Vercel از مقدار جدول استفاده کنید. `vercel.json` مسیرهای `/login/client`، `/login/team`، `/setup` و `/api/*` را تنظیم می‌کند؛ آن را با تنظیمات Next.js جایگزین نکنید.

## متغیرهای اتصال

در Vercel → Project → Settings → Environment Variables، این دو متغیر را برای **Production** و **Preview** تنظیم کنید. نام‌ها دقیقاً مطابق `backend/bff.mjs` هستند:

| نام | مقدار یا محل دریافت | محل مصرف |
| --- | --- | --- |
| `ARIOS_SUPABASE_URL` | `https://qategfabulrkvdckzmqp.supabase.co`؛ پروژهٔ اختصاصی آریوس | runtime سروری BFF |
| `ARIOS_SUPABASE_PUBLISHABLE_KEY` | publishable key از Dashboard همان پروژهٔ Supabase → Settings → API Keys | runtime سروری BFF |

کلید واقعی را فقط در تنظیمات سرویس وارد کنید. نام هیچ‌کدام را به `NEXT_PUBLIC_` یا `VITE_` تغییر ندهید. ساخت صفحه‌های ایستا این مقادیر را داخل JavaScript مرورگر قرار نمی‌دهد. `.env.example` فقط نمونه است و حاوی کلید واقعی نیست.

`SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` را خود Supabase فقط در Edge Function اختصاصی تأمین می‌کند. service role به Vercel یا مرورگر تعلق ندارد. متغیرهای قدیمی SQLite، رمز اولیه، نشست و رمزگذاری Worker هم برای BFF فعلی لازم نیستند.

توکن بات تلگرام و کلید ارائه‌دهندهٔ هوش مصنوعی از فرم «تنظیم اتصال‌ها» پس از ورود مدیر ثبت می‌شوند و در تنظیمات خصوصی backend قرار می‌گیرند. آن‌ها را در مخزن، فایل سمت مرورگر یا چت قرار ندهید.

## backend و ورود

Edge Function آریوس با نام `arios-api` در پروژهٔ اختصاصی `qategfabulrkvdckzmqp` جدا از استقرار Vercel اجرا می‌شود. Import مخزن به‌تنهایی تابع Supabase یا طرح پایگاه داده را منتشر نمی‌کند. مهاجرت SQL موجود در `supabase/migrations/` و کد تابع، منابع همین backend هستند؛ طرح را دوباره روی پایگاه موجود بدون بررسی اجرا نکنید.

مدیر اولیه با لینک خصوصی و یک‌بارمصرف راه‌اندازی حساب می‌سازد؛ کد این لینک در سورس و راهنما نیست. اعضا و مشتریان حساب اختصاصی دارند. انتخاب صفحهٔ ورود نقش ایجاد نمی‌کند؛ نقش و عضویت در سرور بررسی می‌شود.

## بررسی پس از Deploy

۱. صبر کنید وضعیت استقرار در Vercel واقعاً `Ready` شود؛ وجود فایل یا commit به معنی موفقیت Deploy نیست.

۲. صفحهٔ اصلی، `/login/client` و `/login/team` را روی دامنهٔ جدید باز کنید. `/api/session` پیش از ورود باید نشست ناشناس برگرداند و `/api/state` باید دسترسی ناشناس را رد کند. `/api/health` اتصال backend را بررسی می‌کند؛ پاسخ ناموفق آن را با لاگ تابع بررسی کنید.

۳. با حساب واقعی مدیر وارد شوید، سپس دسترسی مشتری و عضو را با حساب‌های خودشان بررسی کنید. توکن نشست باید در کوکی HttpOnly باشد؛ آن را در localStorage یا کد صفحه کپی نکنید.

۴. پس از ثبت تنظیمات اختصاصی تلگرام و هوش مصنوعی، یک ویس آزمایشی را تا پیش‌نویس و ثبت گزارش بررسی کنید. آزمون‌های واحد جای تأیید سرویس واقعی را نمی‌گیرند. دریافت تلگرام فعلاً هنگام باز بودن صفحهٔ مدیر همگام می‌شود؛ وب‌هوک دائمی یا زمان‌بندی پس‌زمینه فعال نیست.

پس از تغییر Environment Variables، یک استقرار جدید لازم است. دامنهٔ منتشرشدهٔ Sites و دادهٔ Supabase با Import این مخزن حذف یا منتقل نمی‌شوند.

## بررسی محلی و احراز هویت امن Git

```bash
npm ci
npm test
npm run build:vercel
```

برای احراز هویت GitHub از اتصال رسمی GitHub App یا ورود مرورگری GitHub CLI با `gh auth login --hostname github.com --git-protocol https --web` استفاده کنید. هیچ توکنی را داخل URL remote، دستور دارای مقدار ثابت، فایل پروژه یا پیام چت قرار ندهید. remote و تاریخچهٔ موجود را پیش از تغییر بررسی کنید؛ از force push برای حل اختلاف تاریخچه استفاده نکنید.
