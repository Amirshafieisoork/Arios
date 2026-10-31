import ir.arioshub.app.SecurityPolicy;
public final class SecurityPolicyTest {
    private static int checks;
    private static void expect(boolean actual, boolean expected, String label) { checks++; if(actual != expected) throw new AssertionError(label); }
    public static void main(String[] args) {
        for(String value : new String[]{"https://arioshub.ir/", "https://arioshub.ir:443/api/session", "https://ARIOSHub.ir/portal/?native=android#reports"}) expect(SecurityPolicy.canonical(value), true, value);
        for(String value : new String[]{null,"", "http://arioshub.ir/", "https://arioshub.ir.evil.test/", "https://arioshub.ir@evil.test/", "https://evil.test@arioshub.ir/", "https://arioshub.ir:444/", "javascript:alert(1)", "intent://arioshub.ir/", "file:///data/data/ir.arioshub.app/", "content://arioshub.ir/", "https://arioshub.ir\\@evil.test/", "https://arioshub.ir./", "//arioshub.ir/"}) expect(SecurityPolicy.canonical(value), false, value);
        String storage="https://qategfabulrkvdckzmqp.supabase.co";
        for(String bucket : new String[]{"arios-project-files", "arios-audio", "arios-backups"}) expect(SecurityPolicy.signedStorageFile(storage+"/storage/v1/object/sign/"+bucket+"/file.bin?token=opaque"),true,bucket);
        for(String value : new String[]{storage+"/storage/v1/object/sign/other/file?token=opaque",storage+"/storage/v1/object/public/arios-backups/file?token=opaque",storage+"/storage/v1/object/sign/arios-backups/file",storage.replace("https:","http:")+"/storage/v1/object/sign/arios-backups/file?token=opaque",storage.replace(".co",".co.evil.test")+"/storage/v1/object/sign/arios-backups/file?token=opaque", "https://user@qategfabulrkvdckzmqp.supabase.co/storage/v1/object/sign/arios-backups/file?token=opaque"}) expect(SecurityPolicy.signedStorageFile(value),false,value);
        for(String value : new String[]{"tel:+989120000000", "mailto:person@example.test", "https://t.me/AriosBot?start=opaque", "https://telegram.me/AriosBot"}) expect(SecurityPolicy.external(value),true,value);
        for(String value : new String[]{"tel:1;param=evil", "javascript:alert(1)", "intent://telegram.me/", "https://t.me.evil.test/", "http://t.me/AriosBot", "https://user@t.me/AriosBot", "https://example.test/"}) expect(SecurityPolicy.external(value),false,value);
        for(String value : new String[]{"https://arioshub.ir/portal/app.mjs",storage+"/storage/v1/object/sign/arios-audio/a?token=x", "blob:https://arioshub.ir/opaque", "data:image/png;base64,AA=="}) expect(SecurityPolicy.resource(value),true,value);
        for(String value : new String[]{"https://evil.test/asset.mjs", "file:///sdcard/secret", "data:text/html,<script>alert(1)</script>", "blob:https://evil.test/id", storage+"/auth/v1/token"}) expect(SecurityPolicy.resource(value),false,value);
        for(String value : new String[]{"../x", "C:\\x\\secret", "\u0000name\n", "", ".", ".."}) {String safe=SecurityPolicy.fileName(value);expect(!safe.contains("/")&&!safe.contains("\\")&&!safe.contains("\u0000")&&!safe.equals(".")&&!safe.equals("..")&&safe.length()>0,true,value);}
        System.out.println("PASS "+checks+" executable Java security policy checks");
    }
}
