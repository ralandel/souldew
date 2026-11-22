import com.dabomstew.pkrandom.FileFunctions;
import com.dabomstew.pkrandom.MiscTweak;
import com.dabomstew.pkrandom.Randomizer;
import com.dabomstew.pkrandom.Settings;
import com.dabomstew.pkrandom.pokemon.Encounter;
import com.dabomstew.pkrandom.pokemon.EncounterSet;
import com.dabomstew.pkrandom.pokemon.Evolution;
import com.dabomstew.pkrandom.pokemon.Pokemon;
import com.dabomstew.pkrandom.pokemon.StaticEncounter;
import com.dabomstew.pkrandom.romhandlers.Gen4RomHandler;
import com.dabomstew.pkrandom.romhandlers.Gen5RomHandler;
import com.dabomstew.pkrandom.romhandlers.Gen6RomHandler;
import com.dabomstew.pkrandom.romhandlers.Gen7RomHandler;
import com.dabomstew.pkrandom.romhandlers.Abstract3DSRomHandler;
import com.dabomstew.pkrandom.exceptions.EncryptedROMException;
import com.dabomstew.pkrandom.constants.Gen5Constants;
import com.dabomstew.pkrandom.newnds.NARCArchive;
import com.dabomstew.pkrandom.pokemon.Move;
import com.dabomstew.pkrandom.pokemon.Type;
import com.dabomstew.pkrandom.romhandlers.RomHandler;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ResourceBundle;

/**
 * Small bridge around Universal Pokemon Randomizer ZX that adds what its CLI lacks:
 * a fixed seed (so two players can build byte-identical ROMs), settings via simple
 * key=value overrides (applied by reflection onto UPR's Settings fields) and a JSON
 * export of the randomized game data (types, evolutions, encounters) for the tracker.
 *
 * Usage:
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge info <rom> [<settings.properties> <seed>]
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge fields
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge randomize <rom> <out.nds> <settings.properties> <seed> <log.txt> <data.json>
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge tmcompat <case.json>   (tests: TmFollow on plain data or a stand-in game)
 *
 * Settings keys starting with @ are souldew's own: @base (a UPR settings string), @miscTweaks and @tmsFollowMoves
 * ("TM compatibility follows the TM moves", see TmFollow – an older bridge ignores it with an "Unknown setting" warning).
 *
 * 3DS games (Gen 6: X/Y, Omega Ruby/Alpha Sapphire; Gen 7: Sun/Moon, Ultra Sun/Ultra Moon) go through UPR ZX's own
 * Gen6/Gen7RomHandler: a decrypted .3ds/.cci/.cxi in, one rebuilt, self-contained .cxi out (the same file every
 * computer builds from the same seed). Besides the @@ lines below, 3DS builds print @@STEP (load / randomize) and
 * @@FILES (how many files the game's romfs has – UPR prints "NCCH: Writing file …" per file while writing), and a
 * dump UPR can't read because it is encrypted ends with @@CODE "encrypted" (souldew never decrypts: a decrypted dump is needed),
 * running out of Java heap with @@CODE "memory".
 *
 * Compiled with --release 8 so it runs on every Java >= 8.
 */
public class SoulLinkBridge {

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("usage: info <rom> [<settings> <seed>] | fields | randomize <rom> <out> <settings> <seed> <log> <json>");
            System.exit(2);
        }
        try {
            if ("info".equals(args[0])) {
                info(args[1], args.length > 3 ? args[2] : null, args.length > 3 ? Long.parseLong(args[3]) : 0L);
            } else if ("arm9".equals(args[0])) {
                // debug: dump UPR's decompressed arm9 so code tweaks can be checked against hacks
                RomHandler h = load(args[1], false);
                Field f = h.getClass().getSuperclass().getDeclaredField("arm9");
                f.setAccessible(true);
                FileOutputStream o = new FileOutputStream(args[2]);
                o.write((byte[]) f.get(h));
                o.close();
            } else if ("fields".equals(args[0])) {
                fields();
            } else if ("randomize".equals(args[0])) {
                randomize(args[1], args[2], args[3], Long.parseLong(args[4]), args[5], args[6]);
            } else if ("tmcompat".equals(args[0])) {
                String json = new String(java.nio.file.Files.readAllBytes(new File(args[1]).toPath()), StandardCharsets.UTF_8);
                System.out.println("@@JSON " + (json.contains("\"tmMoves\"") ? TmFollow.runHandlerCase(json) : TmFollow.runCase(json)));
            } else {
                System.err.println("unknown command " + args[0]);
                System.exit(2);
            }
        } catch (Throwable t) {
            if (isEncrypted(t)) System.out.println("@@CODE " + json("encrypted"));
            else if (t instanceof OutOfMemoryError) System.out.println("@@CODE " + json("memory"));
            System.out.println("@@ERROR " + json(String.valueOf(t)));
            t.printStackTrace();
            System.exit(1);
        }
    }

    /** UPR reports an encrypted 3DS dump as EncryptedROMException – also wrapped in another exception. */
    static boolean isEncrypted(Throwable t) {
        for (int i = 0; t != null && i < 10; i++, t = t.getCause()) if (t instanceof EncryptedROMException) return true;
        return false;
    }

    /** A 3DS file (NCSD cartridge image or a bare NCCH/CXI), by its magic at 0x100 – checked before UPR's other factories. */
    static boolean is3ds(String path) {
        try {
            java.io.RandomAccessFile f = new java.io.RandomAccessFile(path, "r");
            try {
                if (f.length() < 0x200) return false;
                byte[] magic = new byte[4];
                f.seek(0x100);
                f.readFully(magic);
                String m = new String(magic, StandardCharsets.US_ASCII);
                return "NCSD".equals(m) || "NCCH".equals(m);
            } finally {
                f.close();
            }
        } catch (java.io.IOException e) {
            return false;
        }
    }

    /**
     * `followTms`: the game gets a handler that rewrites TM compatibility after UPR picked the TM moves (TmFollow) –
     * Gen 1–3 and 6–7 then load through souldew's subclass instead of UPR's factory (only then: a run without the
     * option loads exactly as before). The original data is read here, before anything is randomized.
     */
    private static RomHandler load(String rom, boolean followTms) throws Exception {
        String path = new File(rom).getAbsolutePath();
        java.util.Random random = com.dabomstew.pkrandom.RandomSource.instance();
        RomHandler handler = null;
        if (is3ds(path)) {
            System.out.println("@@STEP " + json("load"));
            RomHandler.Factory[] ctr = { new Gen6RomHandler.Factory(), new Gen7RomHandler.Factory() };
            for (RomHandler.Factory f : ctr) {
                if (f.isLoadable(path)) {
                    handler = followTms ? followHandler(f, random) : f.create(random);
                    break;
                }
            }
            if (handler == null) {
                throw new IllegalArgumentException("This 3DS game is not supported by Universal Pokemon Randomizer ZX (X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon, Ultra Sun/Ultra Moon): " + path);
            }
            if (!handler.loadRom(path)) throw new IllegalStateException("UPR could not load the 3DS game");
            System.out.println("@@FILES " + romfsFileCount(handler));
            if (followTms) ((TmFollow.Host) handler).setTmFollow(TmFollow.snapshot(handler));
            return handler;
        }
        if (new Gen4RomHandler.Factory().isLoadable(path)) {
            handler = new SafeGen4RomHandler(random);
        } else if (new Gen5RomHandler.Factory().isLoadable(path)) {
            SafeGen5RomHandler.enableFairyByte();
            handler = new SafeGen5RomHandler(random);
        } else {
            RomHandler.Factory[] factories = {
                new com.dabomstew.pkrandom.romhandlers.Gen1RomHandler.Factory(),
                new com.dabomstew.pkrandom.romhandlers.Gen2RomHandler.Factory(),
                new com.dabomstew.pkrandom.romhandlers.Gen3RomHandler.Factory(),
            };
            for (RomHandler.Factory f : factories) {
                if (f.isLoadable(path)) {
                    handler = followTms ? followHandler(f, random) : f.create(random);
                    break;
                }
            }
        }
        if (handler == null) {
            throw new IllegalArgumentException("ROM is not supported by Universal Pokemon Randomizer ZX (Gen 1-5): " + path);
        }
        if (!handler.loadRom(path)) {
            throw new IllegalStateException("UPR could not load the ROM");
        }
        if (handler instanceof SafeGen4RomHandler) ((SafeGen4RomHandler) handler).probeStatics();
        if (handler instanceof SafeGen5RomHandler) ((SafeGen5RomHandler) handler).probe();
        if (followTms) ((TmFollow.Host) handler).setTmFollow(TmFollow.snapshot(handler));
        return handler;
    }

    /** The handler UPR's factory `f` would create, as souldew's subclass that hooks TmFollow in. */
    private static RomHandler followHandler(RomHandler.Factory f, java.util.Random random) {
        if (f instanceof com.dabomstew.pkrandom.romhandlers.Gen1RomHandler.Factory) return new FollowGen1(random);
        if (f instanceof com.dabomstew.pkrandom.romhandlers.Gen2RomHandler.Factory) return new FollowGen2(random);
        if (f instanceof com.dabomstew.pkrandom.romhandlers.Gen3RomHandler.Factory) return new FollowGen3(random);
        if (f instanceof Gen6RomHandler.Factory) return new FollowGen6(random);
        if (f instanceof Gen7RomHandler.Factory) return new FollowGen7(random);
        throw new IllegalStateException("no TM hook for " + f.getClass().getName());
    }

    /** The TmFollow a handler was given (null: the option is off, or the handler isn't souldew's). */
    static TmFollow tmFollowOf(RomHandler h) {
        return h instanceof FollowHolder ? ((FollowHolder) h).follow() : null;
    }

    interface FollowHolder extends TmFollow.Host {
        TmFollow follow();
    }

    // Gen 1–3 and 6–7: UPR's handler plus the hook (Gen 4/5 have it in SafeGen4/5RomHandler below)
    static class FollowGen1 extends com.dabomstew.pkrandom.romhandlers.Gen1RomHandler implements FollowHolder {
        private TmFollow follow;
        FollowGen1(java.util.Random r) { super(r); }
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
    }

    static class FollowGen2 extends com.dabomstew.pkrandom.romhandlers.Gen2RomHandler implements FollowHolder {
        private TmFollow follow;
        FollowGen2(java.util.Random r) { super(r); }
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
    }

    static class FollowGen3 extends com.dabomstew.pkrandom.romhandlers.Gen3RomHandler implements FollowHolder {
        private TmFollow follow;
        FollowGen3(java.util.Random r) { super(r); }
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
    }

    static class FollowGen6 extends Gen6RomHandler implements FollowHolder {
        private TmFollow follow;
        FollowGen6(java.util.Random r) { super(r); }
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
    }

    static class FollowGen7 extends Gen7RomHandler implements FollowHolder {
        private TmFollow follow;
        FollowGen7(java.util.Random r) { super(r); }
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
    }

    /**
     * What the new-run wizard needs to know about a game. With settings and a seed it also does a trial run: the whole
     * randomization in memory, nothing written ("trial": null when UPR got through, else the exception's class name) –
     * a Gen 1–5 game UPR can load but not randomize (a ROM hack or release whose data isn't where UPR expects it:
     * "Index 1286 out of bounds for length 1268" on every build) is then known before the player builds a run.
     */
    private static void info(String rom, String settingsFile, long seed) throws Exception {
        Map<String, String> props = settingsFile == null ? null : readProps(settingsFile);
        RomHandler h = load(rom, props != null && takeFollowTms(props));
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"romName\":").append(json(h.getROMName())).append(',');
        sb.append("\"romCode\":").append(json(h.getROMCode())).append(',');
        sb.append("\"valid\":").append(h.isRomValid()).append(',');
        sb.append("\"generation\":").append(h.generationOfPokemon()).append(',');
        sb.append("\"pokemonCount\":").append(h.getPokemon().size() - 1).append(',');
        if (h instanceof Abstract3DSRomHandler) {
            sb.append("\"system\":\"3ds\",");
            sb.append("\"titleId\":").append(json(((Abstract3DSRomHandler) h).getTitleIdFromLoadedROM())).append(',');
        }
        boolean safe4 = h instanceof SafeGen4RomHandler;
        boolean statics5Broken = h instanceof SafeGen5RomHandler && ((SafeGen5RomHandler) h).staticsBroken;
        sb.append("\"introScriptFixes\":").append(safe4 ? ((SafeGen4RomHandler) h).marillEntriesRemoved : 0).append(',');
        sb.append("\"staticsSupported\":").append(safe4 ? !((SafeGen4RomHandler) h).staticsBroken : !statics5Broken && h.canChangeStaticPokemon()).append(',');
        SafeGen5RomHandler g5 = h instanceof SafeGen5RomHandler ? (SafeGen5RomHandler) h : null;
        sb.append("\"startersSupported\":").append(g5 == null || !g5.startersBroken).append(',');
        sb.append("\"tutorsSupported\":").append(g5 == null || !g5.tutorsBroken).append(',');
        sb.append("\"shopsSupported\":").append(g5 == null || !g5.shopsBroken).append(',');
        sb.append("\"fairyInGame\":").append(h.typeInGame(com.dabomstew.pkrandom.pokemon.Type.FAIRY)).append(',');
        int available = h.miscTweaksAvailable();
        sb.append("\"miscTweaks\":[");
        boolean first = true;
        for (MiscTweak mt : MiscTweak.allTweaks) {
            if ((available & mt.getValue()) != 0) {
                if (!first) sb.append(',');
                first = false;
                sb.append(json(tweakFieldName(mt)));
            }
        }
        sb.append("],\"starters\":[");
        first = true;
        for (Pokemon p : h.getStarters()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(json(p.fullName()));
        }
        sb.append(']');
        // (last: the trial changes the loaded game's data)
        if (props != null && !(h instanceof Abstract3DSRomHandler)) sb.append(",\"trial\":").append(json(trial(h, props, seed)));
        sb.append('}');
        System.out.println("@@JSON " + sb);
    }

    /** A randomization that writes nothing (see info): null when it went through, else the exception's class name. */
    private static String trial(RomHandler h, Map<String, String> props, long seed) {
        try {
            Settings settings = forRom(h, readSettings(props));
            PrintStream log = new PrintStream(new ByteArrayOutputStream(), true, "UTF-8");
            // saveAsDirectory: Gen 1–5 handlers then save nothing – the write-back into the game's data that saving
            // does first (stats, moves …) is called by hand, in memory
            new Randomizer(settings, h, ResourceBundle.getBundle("com/dabomstew/pkrandom/newgui/Bundle"), true).randomize("", log, seed);
            for (Class<?> c = h.getClass(); c != null; c = c.getSuperclass()) {
                for (java.lang.reflect.Method m : c.getDeclaredMethods()) {
                    if ((m.getName().equals("savingROM") || m.getName().equals("savingRom")) && m.getParameterTypes().length == 0 && !Modifier.isAbstract(m.getModifiers())) {
                        m.setAccessible(true);
                        m.invoke(h);
                        return null;
                    }
                }
            }
            return null;
        } catch (Throwable t) {
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null ? t.getCause() : t;
            // where it stopped, for the app's diagnostics (server/lib/toolchain.mjs randomizerTrace) – stderr only
            System.err.println("@@TRIAL " + cause);
            cause.printStackTrace();
            return cause.getClass().getSimpleName();
        }
    }

    private static void fields() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Field f : Settings.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            if (!first) sb.append(',');
            first = false;
            Class<?> t = f.getType();
            sb.append(json(f.getName())).append(":{\"type\":").append(json(t.getSimpleName()));
            if (t.isEnum()) {
                sb.append(",\"values\":[");
                Object[] cs = t.getEnumConstants();
                for (int i = 0; i < cs.length; i++) {
                    if (i > 0) sb.append(',');
                    sb.append(json(((Enum<?>) cs[i]).name()));
                }
                sb.append(']');
            }
            sb.append('}');
        }
        sb.append(",\"@miscTweaks\":{\"type\":\"list\",\"values\":[");
        first = true;
        for (MiscTweak mt : MiscTweak.allTweaks) {
            if (!first) sb.append(',');
            first = false;
            sb.append(json(tweakFieldName(mt)));
        }
        sb.append("]}}");
        System.out.println("@@JSON " + sb);
    }

    private static String tweakFieldName(MiscTweak mt) {
        for (Field f : MiscTweak.class.getFields()) {
            try {
                if (Modifier.isStatic(f.getModifiers()) && f.get(null) == mt) return f.getName();
            } catch (IllegalAccessException ignored) {
            }
        }
        return String.valueOf(mt.getValue());
    }

    static final String FOLLOW_TMS = "@tmsFollowMoves";

    /** @tmsFollowMoves=true – taken out of `props` (it's no UPR field). */
    static boolean takeFollowTms(Map<String, String> props) {
        return Boolean.parseBoolean(props.remove(FOLLOW_TMS));
    }

    private static Map<String, String> readProps(String file) throws Exception {
        Map<String, String> props = new LinkedHashMap<String, String>();
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq < 0) continue;
            props.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
        }
        r.close();
        return props;
    }

    private static Settings readSettings(Map<String, String> input) throws Exception {
        Map<String, String> props = new LinkedHashMap<String, String>(input);
        Settings s;
        String base = props.remove("@base");
        if (base != null && !base.isEmpty()) {
            // A settings string copied from the UPR GUI ("Settings string" in the log / Load settings).
            s = Settings.fromString(base);
        } else {
            s = new Settings();
            fillDefaults(s);
        }
        String tweaks = props.remove("@miscTweaks");
        if (tweaks != null) {
            int value = 0;
            for (String name : tweaks.split(",")) {
                name = name.trim();
                if (name.isEmpty()) continue;
                Field f = MiscTweak.class.getField(name);
                value |= ((MiscTweak) f.get(null)).getValue();
            }
            s.setCurrentMiscTweaks(value);
        }
        for (Map.Entry<String, String> e : props.entrySet()) {
            Field f;
            try {
                f = Settings.class.getDeclaredField(e.getKey());
            } catch (NoSuchFieldException ex) {
                System.out.println("@@WARN " + json("Unknown setting ignored: " + e.getKey()));
                continue;
            }
            f.setAccessible(true);
            Class<?> t = f.getType();
            String v = e.getValue();
            if (t == boolean.class) {
                f.setBoolean(s, Boolean.parseBoolean(v));
            } else if (t == int.class) {
                f.setInt(s, Integer.parseInt(v));
            } else if (t == int[].class) {
                String[] parts = v.split(",");
                int[] arr = new int[parts.length];
                for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
                f.set(s, arr);
            } else if (t == String.class) {
                f.set(s, v);
            } else if (t.isEnum()) {
                f.set(s, enumValue(t, v));
            } else {
                System.out.println("@@WARN " + json("Unsupported setting type for " + e.getKey()));
            }
        }
        s.setCustomNames(FileFunctions.getCustomNames());
        return s;
    }

    /** A bare `new Settings()` leaves fields null that toString()/randomize() dereference. */
    private static void fillDefaults(Settings s) throws Exception {
        for (Field f : Settings.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            f.setAccessible(true);
            if (f.get(s) != null) continue;
            Class<?> t = f.getType();
            if (t.isEnum()) {
                f.set(s, t.getEnumConstants()[0]);
            } else if (t == int[].class) {
                f.set(s, new int[]{0, 0, 0});
            } else if (t == String.class) {
                f.set(s, "");
            } else if (t == com.dabomstew.pkrandom.pokemon.GenRestrictions.class) {
                f.set(s, new com.dabomstew.pkrandom.pokemon.GenRestrictions());
            }
        }
        Field curve = Settings.class.getDeclaredField("selectedEXPCurve");
        curve.setAccessible(true);
        curve.set(s, com.dabomstew.pkrandom.pokemon.ExpCurve.MEDIUM_FAST);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumValue(Class<?> t, String v) {
        return Enum.valueOf((Class) t, v);
    }

    private static void setField(Settings s, String name, Object value) throws ReflectiveOperationException {
        Field f = Settings.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(s, value);
    }

    /** Settings made ready for the loaded game – the same for a build and a trial run. */
    private static Settings forRom(RomHandler h, Settings settings) throws Exception {
        settings.setRomName(h.getROMName());
        boolean staticsBroken = (h instanceof SafeGen4RomHandler && ((SafeGen4RomHandler) h).staticsBroken)
                || (h instanceof SafeGen5RomHandler && ((SafeGen5RomHandler) h).staticsBroken);
        if (staticsBroken && settings.getStaticPokemonMod() != Settings.StaticPokemonMod.UNCHANGED) {
            Field f = Settings.class.getDeclaredField("staticPokemonMod");
            f.setAccessible(true);
            f.set(settings, Settings.StaticPokemonMod.UNCHANGED);
            System.out.println("@@WARN " + json("Static Pokemon cannot be randomized in this ROM hack (scripts differ from vanilla) - left unchanged"));
        }
        if (h instanceof SafeGen5RomHandler) {
            SafeGen5RomHandler g5 = (SafeGen5RomHandler) h;
            if (g5.startersBroken && settings.getStartersMod() != Settings.StartersMod.UNCHANGED) {
                setField(settings, "startersMod", Settings.StartersMod.UNCHANGED);
                System.out.println("@@WARN " + json("Starters cannot be randomized in this ROM hack (its intro script differs from vanilla) - left unchanged"));
            }
            if (g5.tutorsBroken && settings.getMoveTutorMovesMod() != Settings.MoveTutorMovesMod.UNCHANGED) {
                setField(settings, "moveTutorMovesMod", Settings.MoveTutorMovesMod.UNCHANGED);
                System.out.println("@@WARN " + json("Move tutors cannot be randomized in this ROM hack (their table isn't where the randomizer writes it) - left unchanged"));
            }
            if (g5.shopsBroken && settings.getShopItemsMod() != Settings.ShopItemsMod.UNCHANGED) {
                setField(settings, "shopItemsMod", Settings.ShopItemsMod.UNCHANGED);
                System.out.println("@@WARN " + json("Shop items cannot be randomized in this ROM hack (its shop code differs from vanilla) - left unchanged"));
            }
        }
        Settings.TweakForROMFeedback fb = settings.tweakForRom(h);
        if (fb.isChangedStarter()) System.out.println("@@WARN " + json("Custom starters were adjusted for this ROM"));
        if (fb.isRemovedCodeTweaks()) System.out.println("@@WARN " + json("Some code tweaks are not supported by this ROM and were removed"));
        return settings;
    }

    private static void randomize(String rom, String out, String settingsFile, long seed, String logFile, String jsonFile) throws Exception {
        Map<String, String> props = readProps(settingsFile);
        boolean followTms = takeFollowTms(props);
        Settings settings = readSettings(props);
        RomHandler h = load(rom, followTms);
        forRom(h, settings);
        System.out.println("@@SETTINGS " + json(settings.toString()));

        if (h instanceof Abstract3DSRomHandler) System.out.println("@@STEP " + json("randomize"));
        ResourceBundle bundle = ResourceBundle.getBundle("com/dabomstew/pkrandom/newgui/Bundle");
        ByteArrayOutputStream logBytes = new ByteArrayOutputStream();
        PrintStream log = new PrintStream(logBytes, true, "UTF-8");
        // (false: one file – a .nds/.gba/… or, for a 3DS game, a rebuilt .cxi – never a LayeredFS folder)
        int check = new Randomizer(settings, h, bundle, false).randomize(new File(out).getAbsolutePath(), log, seed);
        TmFollow follow = tmFollowOf(h);
        if (follow != null) {
            if (!follow.applied) {
                // UPR only picks new TM moves with "TM moves: random" (and not with "Metronome only")
                System.out.println("@@WARN " + json("TM compatibility can only follow the TM moves when the TM moves are random - left unchanged"));
            } else {
                log.println("--TM Compatibility Follows The TM Moves--");
                for (String line : follow.report) log.println(line);
                log.println();
            }
        }
        log.close();
        FileOutputStream lf = new FileOutputStream(logFile);
        lf.write(logBytes.toByteArray());
        lf.close();

        Writer w = new OutputStreamWriter(new FileOutputStream(jsonFile), StandardCharsets.UTF_8);
        w.write(exportData(h, settings, seed, check));
        w.close();
        System.out.println("@@DONE " + json(String.valueOf(check)));
    }

    private static String exportData(RomHandler h, Settings settings, long seed, int check) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"seed\":").append(json(String.valueOf(seed))).append(',');
        sb.append("\"checkValue\":").append(check).append(',');
        sb.append("\"settingsString\":").append(json(settings.toString())).append(',');
        sb.append("\"romName\":").append(json(h.getROMName())).append(',');
        sb.append("\"pokemon\":[");
        List<Pokemon> list = h.getPokemonInclFormes();
        boolean first = true;
        for (Pokemon p : list) {
            if (p == null) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":").append(p.number)
              .append(",\"name\":").append(json(p.fullName()))
              .append(",\"forme\":").append(p.formeNumber)
              .append(",\"types\":[").append(json(p.primaryType == null ? null : p.primaryType.name()));
            if (p.secondaryType != null) sb.append(',').append(json(p.secondaryType.name()));
            sb.append("],\"stats\":[").append(p.hp).append(',').append(p.attack).append(',').append(p.defense)
              .append(',').append(p.spatk).append(',').append(p.spdef).append(',').append(p.speed).append(']')
              .append(",\"abilities\":[").append(json(h.abilityName(p.ability1))).append(',')
              .append(json(h.abilityName(p.ability2))).append(',').append(json(p.ability3 > 0 ? h.abilityName(p.ability3) : "")).append(']')
              .append(",\"catchRate\":").append(p.catchRate)
              .append(",\"evolvesTo\":[");
            boolean f2 = true;
            for (Evolution e : p.evolutionsFrom) {
                if (!f2) sb.append(',');
                f2 = false;
                sb.append("{\"to\":").append(e.to.number).append(",\"method\":").append(json(e.type.name()))
                  .append(",\"param\":").append(e.extraInfo).append('}');
            }
            sb.append("],\"evolvesFrom\":[");
            f2 = true;
            for (Evolution e : p.evolutionsTo) {
                if (!f2) sb.append(',');
                f2 = false;
                sb.append(e.from.number);
            }
            sb.append("]}");
        }
        sb.append("],\"starters\":[");
        first = true;
        for (Pokemon p : h.getStarters()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(p.number);
        }
        sb.append("],\"encounters\":[");
        first = true;
        List<EncounterSet> sets = new ArrayList<EncounterSet>();
        try {
            sets = h.getEncounters(true);
        } catch (Exception ignored) {
        }
        for (EncounterSet es : sets) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"area\":").append(json(es.displayName)).append(",\"rate\":").append(es.rate).append(",\"slots\":[");
            boolean f2 = true;
            for (Encounter enc : es.encounters) {
                if (enc.pokemon == null) continue;
                if (!f2) sb.append(',');
                f2 = false;
                sb.append('[').append(enc.pokemon.number).append(',').append(enc.level).append(',')
                  .append(Math.max(enc.level, enc.maxLevel)).append(']');
            }
            sb.append("]}");
        }
        sb.append("],\"statics\":[");
        first = true;
        List<StaticEncounter> statics = new ArrayList<StaticEncounter>();
        try {
            statics = h.getStaticPokemon();
        } catch (Exception ignored) {
        }
        for (StaticEncounter se : statics) {
            if (se.pkmn == null) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append('[').append(se.pkmn.number).append(',').append(se.level).append(']');
        }
        sb.append("]}");
        return sb.toString();
    }

    /** How many files the loaded 3DS game's romfs has (UPR's NCCH keeps them private) – -1 if that can't be read. */
    static int romfsFileCount(RomHandler h) {
        try {
            Field base = Abstract3DSRomHandler.class.getDeclaredField("baseRom");
            base.setAccessible(true);
            Object ncch = base.get(h);
            Field files = ncch.getClass().getDeclaredField("romfsFiles");
            files.setAccessible(true);
            return ((Map<?, ?>) files.get(ncch)).size();
        } catch (Exception e) {
            return -1;
        }
    }

    /**
     * ROM hacks rewrite event scripts, so UPR's hardcoded static-encounter script offsets can point
     * past the end of a file (Definitive HeartGold does this). Reading them then throws, and
     * Randomizer.randomize() always reads them. We detect that once and treat statics as unavailable.
     */
    static class SafeGen4RomHandler extends Gen4RomHandler implements FollowHolder {

        private TmFollow follow;
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
        boolean staticsBroken;

        SafeGen4RomHandler(java.util.Random random) {
            super(random);
        }

        int marillEntriesRemoved;

        void probeStatics() {
            try {
                super.getStaticPokemon();
            } catch (RuntimeException e) {
                staticsBroken = true;
            }
            sanitizeMarillCryScripts();
        }

        /**
         * randomizeIntroPokemon() always rewrites Marill's cry id at hardcoded script offsets.
         * In hacks some of those offsets now hold other script bytes, so only keep entries that
         * really contain Marill (#183) — everything else would be silently corrupted.
         */
        @SuppressWarnings("unchecked")
        void sanitizeMarillCryScripts() {
            try {
                Field entryField = Gen4RomHandler.class.getDeclaredField("romEntry");
                entryField.setAccessible(true);
                Object entry = entryField.get(this);
                Field listField = entry.getClass().getDeclaredField("marillCryScriptEntries");
                listField.setAccessible(true);
                List<Object> list = (List<Object>) listField.get(entry);
                Field narcField = Gen4RomHandler.class.getDeclaredField("scriptNarc");
                narcField.setAccessible(true);
                com.dabomstew.pkrandom.newnds.NARCArchive narc = (com.dabomstew.pkrandom.newnds.NARCArchive) narcField.get(this);
                if (list == null || narc == null) return;
                java.util.Iterator<Object> it = list.iterator();
                while (it.hasNext()) {
                    Object se = it.next();
                    Field ff = se.getClass().getDeclaredField("scriptFile");
                    Field fo = se.getClass().getDeclaredField("scriptOffset");
                    ff.setAccessible(true);
                    fo.setAccessible(true);
                    int file = ff.getInt(se);
                    int off = fo.getInt(se);
                    byte[] data = file < narc.files.size() ? narc.files.get(file) : null;
                    boolean ok = data != null && off + 1 < data.length
                            && ((data[off] & 0xFF) | ((data[off + 1] & 0xFF) << 8)) == 183;
                    if (!ok) {
                        it.remove();
                        marillEntriesRemoved++;
                    }
                }
            } catch (Exception e) {
                System.out.println("@@WARN " + json("Could not validate intro script offsets: " + e));
            }
        }

        @Override
        public List<StaticEncounter> getStaticPokemon() {
            if (staticsBroken) return new ArrayList<StaticEncounter>();
            return super.getStaticPokemon();
        }

        @Override
        public boolean setStaticPokemon(List<StaticEncounter> statics) {
            if (staticsBroken) return true;
            return super.setStaticPokemon(statics);
        }

        @Override
        public boolean canChangeStaticPokemon() {
            return !staticsBroken && super.canChangeStaticPokemon();
        }
    }

    /**
     * Gen 5 ROM hacks (Blaze Black 2 / Volt White 2 Redux, …) add the Fairy type as type byte 17 – UPR's Gen 5 tables
     * stop at Dark (16), so those moves and Pokémon came out with no type and the randomizer crashed in its type
     * matchups ("attackingType is null"). Byte 17 now reads as Fairy, the Gen 6 matchup table (which has Fairy) is
     * used for such a ROM, and on saving Fairy goes back out as 17 (UPR's own writer would turn it into Normal).
     * Static encounters whose scripts the hack rewrote are treated like in Gen 4: unavailable instead of a crash.
     */
    static class SafeGen5RomHandler extends Gen5RomHandler implements FollowHolder {

        private TmFollow follow;
        public void setTmFollow(TmFollow f) { follow = f; }
        public TmFollow follow() { return follow; }
        @Override public void randomizeTMMoves(Settings s) { super.randomizeTMMoves(s); if (follow != null) follow.apply(this, s); }
        static final int FAIRY_BYTE = 17;
        boolean staticsBroken;
        boolean fairy;
        /**
         * UPR writes the starters into a script file at fixed offsets (StarterOffsets1–3 – Black 2: script 854, the
         * new game's intro) and its "National Pokédex from the start" tweak patches that script's retail bytes (an
         * IPS). A ROM hack with its own intro script (Blaze Black 2 Redux) got garbage written into it: the game went
         * black in the intro, before the name entry (#43). Starters are where UPR expects them when every offset of a
         * starter holds the same Pokémon.
         */
        boolean startersBroken;
        /** The National Pokédex tweak's script may not be the retail one (a modified ROM where it can't be checked). */
        boolean natDexScriptUnknown;
        /** "Fastest text" patches the main program at fixed offsets (an IPS): only on the retail main program. */
        boolean arm9Changed;
        /**
         * Move tutors (Black 2 / White 2): UPR writes the 60 tutor moves into an overlay at a fixed offset – only where
         * that overlay is the retail one or the table there reads as tutor moves (1…559, 12 bytes apart).
         */
        boolean tutorsBroken;
        /** Shops (Black / White): UPR writes the shop lists into an overlay at fixed offsets – only into the retail one. */
        boolean shopsBroken;

        SafeGen5RomHandler(java.util.Random random) {
            super(random);
        }

        /** Before loading: let byte 17 read as Fairy (vanilla games never use it, so they're unaffected). */
        static void enableFairyByte() {
            if (Gen5Constants.typeTable.length > FAIRY_BYTE && Gen5Constants.typeTable[FAIRY_BYTE] == null) {
                Gen5Constants.typeTable[FAIRY_BYTE] = Type.FAIRY;
            }
        }

        void probe() {
            for (Move m : getMoves()) if (m != null && m.type == Type.FAIRY) fairy = true;
            for (Pokemon p : getPokemonInclFormes()) {
                if (p != null && (p.primaryType == Type.FAIRY || p.secondaryType == Type.FAIRY)) fairy = true;
            }
            if (fairy) System.out.println("@@WARN " + json("This ROM hack adds the Fairy type - kept as it is, with the Gen 6 type chart for the randomizer's choices"));
            try {
                List<StaticEncounter> list = super.getStaticPokemon();
                for (StaticEncounter se : list) if (se == null || se.pkmn == null) throw new IllegalStateException("empty static");
            } catch (RuntimeException e) {
                staticsBroken = true;
            }
            Integer starterFile = null;
            try {
                starterFile = startersFile();
            } catch (ReflectiveOperationException | RuntimeException e) {
                startersBroken = true;
            }
            // the tweak's script: retail when the whole ROM is (UPR's checksums), or when it is the starters' script and
            // those are where UPR expects them; else unknown – the tweak isn't offered
            try {
                Object entry = field("romEntry");
                Field nums = entry.getClass().getDeclaredField("numbers");
                nums.setAccessible(true);
                Object natDex = ((Map<?, ?>) nums.get(entry)).get("NationalDexScriptOffset");
                natDexScriptUnknown = !isRomValid() && (startersBroken || starterFile == null || !starterFile.equals(natDex));
            } catch (ReflectiveOperationException | RuntimeException e) {
                natDexScriptUnknown = !isRomValid();
            }
            try {
                Object entry = field("romEntry");
                arm9Changed = ((Long) field("actualArm9CRC32")).longValue() != ((Long) entryField(entry, "arm9ExpectedCRC32")).longValue();
                Map<?, ?> nums = (Map<?, ?>) entryField(entry, "numbers");
                if (hasMoveTutors()) {
                    int ovl = (Integer) nums.get("MoveTutorOvlNumber");
                    tutorsBroken = !overlayRetail(entry, ovl) && !tutorTable(readOverlay(ovl), (Integer) nums.get("MoveTutorDataOffset"));
                }
                if (entryField(entry, "romType").equals(Gen5Constants.Type_BW) && nums.get("ShopItemOvlNumber") != null) {
                    shopsBroken = !overlayRetail(entry, (Integer) nums.get("ShopItemOvlNumber"));
                }
            } catch (ReflectiveOperationException | java.io.IOException | RuntimeException e) {
                arm9Changed = !isRomValid();
                tutorsBroken = !isRomValid() && hasMoveTutors();
                shopsBroken = !isRomValid();
            }
        }

        private static Object entryField(Object entry, String name) throws ReflectiveOperationException {
            Field f = entry.getClass().getDeclaredField(name);
            f.setAccessible(true);
            return f.get(entry);
        }

        /** Is overlay `ovl` the retail one (UPR's checksum of the game it knows)? */
        private boolean overlayRetail(Object entry, int ovl) throws ReflectiveOperationException {
            Long want = (Long) ((Map<?, ?>) entryField(entry, "overlayExpectedCRC32s")).get(ovl);
            Long have = (Long) ((Map<?, ?>) field("actualOverlayCRC32s")).get(ovl);
            return want != null && want.equals(have);
        }

        /** 60 tutor entries of 12 bytes from `at`, each starting with a move (1…559). */
        private static boolean tutorTable(byte[] ovl, Integer at) {
            if (at == null || at < 0 || at + 60 * 12 > ovl.length) return false;
            for (int i = 0; i < 60; i++) {
                int m = (ovl[at + i * 12] & 0xff) | ((ovl[at + i * 12 + 1] & 0xff) << 8);
                if (m < 1 || m > Gen5Constants.moveCount) return false;
            }
            return true;
        }

        @Override
        public void setMoveTutorMoves(List<Integer> moves) {
            if (!tutorsBroken) super.setMoveTutorMoves(moves);
        }

        @Override
        public void setShopItems(Map<Integer, com.dabomstew.pkrandom.pokemon.Shop> shops) {
            if (!shopsBroken) super.setShopItems(shops);
        }

        /**
         * The script file the starters are in (null: this game has no starter offsets) – throws when an offset is outside
         * its file or the offsets of a starter don't all hold the same Pokémon (1…649).
         */
        private Integer startersFile() throws ReflectiveOperationException {
            Object entry = field("romEntry");
            Field f = entry.getClass().getDeclaredField("offsetArrayEntries");
            f.setAccessible(true);
            Map<?, ?> offsets = (Map<?, ?>) f.get(entry);
            NARCArchive scripts = (NARCArchive) field("scriptNarc");
            Integer file = null;
            for (int i = 1; i <= 3; i++) {
                Object[] list = (Object[]) offsets.get("StarterOffsets" + i);
                if (list == null) return file;
                int species = -1;
                for (Object o : list) {
                    Field ef = o.getClass().getDeclaredField("entry");
                    Field of = o.getClass().getDeclaredField("offset");
                    ef.setAccessible(true);
                    of.setAccessible(true);
                    int e = ef.getInt(o);
                    int off = of.getInt(o);
                    byte[] d = scripts.files.get(e);
                    if (off < 0 || off + 2 > d.length) throw new IllegalStateException("starter offset outside the script");
                    int v = (d[off] & 0xff) | ((d[off + 1] & 0xff) << 8);
                    if (v < 1 || v > Gen5Constants.pokemonCount || (species >= 0 && v != species)) throw new IllegalStateException("not the starters");
                    species = v;
                    if (file == null) file = e;
                }
            }
            return file;
        }

        @Override
        public boolean setStarters(List<Pokemon> starters) {
            if (startersBroken) return true; // (the hack's starters stay)
            return super.setStarters(starters);
        }

        /** The tweaks that patch retail code or scripts at fixed places aren't offered where those aren't retail. */
        @Override
        public int miscTweaksAvailable() {
            int v = super.miscTweaksAvailable();
            if (natDexScriptUnknown) v &= ~MiscTweak.NATIONAL_DEX_AT_START.getValue();
            if (arm9Changed) v &= ~MiscTweak.FASTEST_TEXT.getValue();
            return v;
        }

        @Override
        public void applyMiscTweak(MiscTweak tweak) {
            if (tweak == MiscTweak.NATIONAL_DEX_AT_START && natDexScriptUnknown) return;
            if (tweak == MiscTweak.FASTEST_TEXT && arm9Changed) return;
            super.applyMiscTweak(tweak);
        }

        @Override
        public boolean isEffectivenessUpdated() {
            return fairy || super.isEffectivenessUpdated();
        }

        @Override
        public boolean typeInGame(Type type) {
            if (type == Type.FAIRY) return fairy;
            return super.typeInGame(type);
        }

        @Override
        public List<StaticEncounter> getStaticPokemon() {
            if (staticsBroken) return new ArrayList<StaticEncounter>();
            return super.getStaticPokemon();
        }

        @Override
        public boolean setStaticPokemon(List<StaticEncounter> statics) {
            if (staticsBroken) return true;
            return super.setStaticPokemon(statics);
        }

        @Override
        public boolean canChangeStaticPokemon() {
            return !staticsBroken && super.canChangeStaticPokemon();
        }

        /** UPR's Gen 5 item and matchup tables have no Fairy: a Fairy move or Pokémon made "sensible held items" crash – fall back. */
        @Override
        public List<Integer> getSensibleHeldItemsFor(com.dabomstew.pkrandom.pokemon.TrainerPokemon tp, boolean consumableOnly, List<Move> moves, int[] pokeMoves) {
            try {
                return super.getSensibleHeldItemsFor(tp, consumableOnly, moves, pokeMoves);
            } catch (RuntimeException e) { // NullPointerException / ArrayIndexOutOfBounds from the Gen 5 tables
                return consumableOnly ? getAllConsumableHeldItems() : getAllHeldItems();
            }
        }

        @Override
        public void writeNARC(String name, NARCArchive narc) throws java.io.IOException {
            if (fairy) {
                try {
                    restoreFairy(narc);
                } catch (ReflectiveOperationException e) {
                    throw new IllegalStateException("could not keep the Fairy type: " + e);
                }
            }
            super.writeNARC(name, narc);
        }

        private Object field(String name) throws ReflectiveOperationException {
            Field f = Gen5RomHandler.class.getDeclaredField(name);
            f.setAccessible(true);
            return f.get(this);
        }

        /** UPR wrote Fairy as 0 (Normal): put byte 17 back where the data in memory says Fairy. */
        private void restoreFairy(NARCArchive narc) throws ReflectiveOperationException {
            if (narc == field("moveNarc")) {
                Move[] moves = (Move[]) field("moves");
                for (int i = 1; i < moves.length && i < narc.files.size(); i++) {
                    if (moves[i] != null && moves[i].type == Type.FAIRY) narc.files.get(i)[0] = (byte) FAIRY_BYTE;
                }
            } else if (narc == field("pokeNarc")) {
                Pokemon[] pokes = (Pokemon[]) field("pokes");
                Object entry = field("romEntry");
                Field rt = entry.getClass().getDeclaredField("romType");
                rt.setAccessible(true);
                int formeOffset = Gen5Constants.getFormeOffset(rt.getInt(entry));
                for (int i = 1; i < pokes.length; i++) {
                    Pokemon p = pokes[i];
                    int file = i <= Gen5Constants.pokemonCount ? i : i + formeOffset;
                    if (p == null || file >= narc.files.size()) continue;
                    byte[] d = narc.files.get(file);
                    if (p.primaryType == Type.FAIRY) d[6] = (byte) FAIRY_BYTE;
                    if (p.secondaryType == Type.FAIRY || (p.secondaryType == null && p.primaryType == Type.FAIRY)) d[7] = (byte) FAIRY_BYTE;
                }
            }
        }
    }

    private static String json(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
