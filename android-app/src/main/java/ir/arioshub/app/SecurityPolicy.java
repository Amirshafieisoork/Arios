package ir.arioshub.app;

import java.net.URI;

/** Exact origins, never user-supplied suffix matches or intent/file navigation. */
public final class SecurityPolicy {
    public static final String ORIGIN = "https://arioshub.ir";
    public static final String STORAGE_HOST = "qategfabulrkvdckzmqp.supabase.co";
    private SecurityPolicy() {}
    private static URI parse(String value) { try { return new URI(value); } catch (Exception e) { return null; } }
    private static boolean https(URI u) { return u != null && "https".equalsIgnoreCase(u.getScheme()) && u.getRawUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443); }
    public static boolean canonical(String value) { URI u = parse(value); return https(u) && "arioshub.ir".equalsIgnoreCase(u.getHost()); }
    public static boolean signedStorageFile(String value) {
        URI u = parse(value);
        if (!https(u) || !STORAGE_HOST.equalsIgnoreCase(u.getHost()) || u.getRawQuery() == null) return false;
        String p = u.getPath();
        return p != null && (p.startsWith("/storage/v1/object/sign/arios-project-files/") || p.startsWith("/storage/v1/object/sign/arios-audio/") || p.startsWith("/storage/v1/object/sign/arios-backups/"));
    }
    public static boolean resource(String value) {
        if (canonical(value)) return true;
        URI u = parse(value);
        if (https(u) && STORAGE_HOST.equalsIgnoreCase(u.getHost())) return u.getPath() != null && u.getPath().startsWith("/storage/v1/");
        return value != null && (value.startsWith("blob:" + ORIGIN + "/") || value.startsWith("data:image/"));
    }
    public static boolean external(String value) {
        URI u = parse(value); if (u == null || u.getRawUserInfo() != null) return false;
        if ("tel".equalsIgnoreCase(u.getScheme())) return value.matches("tel:[+0-9()-]{3,30}");
        if ("mailto".equalsIgnoreCase(u.getScheme())) return value.length() <= 300 && !value.matches(".*[\\r\\n].*");
        return https(u) && ("t.me".equalsIgnoreCase(u.getHost()) || "telegram.me".equalsIgnoreCase(u.getHost()));
    }
    public static String fileName(String value) {
        String safe = value == null ? "Arios-file" : value.replaceAll("[\\\\/\\p{Cntrl}]", "_").trim();
        if (safe.length() == 0 || safe.equals(".") || safe.equals("..")) safe = "Arios-file";
        return safe.substring(0, Math.min(120, safe.length()));
    }
}
