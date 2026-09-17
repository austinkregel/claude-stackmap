// Export one program of a Ghidra project as JSON for stackmap to read. stackmap never runs Ghidra: the
// agent that owns the project runs this script, read-only, and stackmap only reads what it writes.
//
//   analyzeHeadless <projectDir> <projectName> -process <program> -readOnly -noanalysis \
//       -scriptPath <stackmap>/ghidra_scripts -postScript StackmapExport.java [decompile_timeout=<s>] [out=<file>]
//
// Arguments (key=value):
//   decompile_timeout  seconds per function for the decompiler (default 60). Every function is
//                      decompiled; each one that fails or times out is recorded with the reason.
//   out                where to write. Default: <projectDir>/<projectName>.stackmap/<program path>.json,
//                      beside the .gpr, which is where stackmap looks.
//
// The file is written to a temporary name and renamed into place, so a reader never sees half of it.
// FORMAT_VERSION must equal FORMAT_VERSION in src/adapters/ghidra/format.ts; plugin-test checks it.
//
// @category Stackmap
import com.google.gson.stream.JsonWriter;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.framework.model.ProjectLocator;
import ghidra.framework.options.Options;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.data.BitFieldDataType;
import ghidra.program.model.data.Composite;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.DataTypeComponent;
import ghidra.program.model.data.DataTypeManager;
import ghidra.program.model.data.SourceArchive;
import ghidra.program.model.data.Structure;
import ghidra.program.model.data.Union;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class StackmapExport extends GhidraScript {
    static final int FORMAT_VERSION = 2;

    private JsonWriter w;

    private static String hex(long v) {
        return "0x" + Long.toHexString(v);
    }

    /** An address as text: 0x-hex in the default space, "<space>::0x<hex>" in any other. */
    private String addr(Address a) {
        if (a == null) return null;
        String h = hex(a.getOffset());
        return a.getAddressSpace().equals(currentProgram.getAddressFactory().getDefaultAddressSpace())
            ? h : a.getAddressSpace().getName() + "::" + h;
    }

    private Map<String, String> args() {
        Map<String, String> out = new HashMap<>();
        for (String a : getScriptArgs()) {
            int eq = a.indexOf('=');
            if (eq <= 0) throw new IllegalArgumentException("StackmapExport: argument \"" + a + "\" is not key=value");
            String key = a.substring(0, eq);
            if (!key.equals("decompile_timeout") && !key.equals("out")) {
                throw new IllegalArgumentException("StackmapExport: unknown argument \"" + key + "\" (known: decompile_timeout, out)");
            }
            out.put(key, a.substring(eq + 1));
        }
        return out;
    }

    @Override
    public void run() throws Exception {
        Map<String, String> args = args();
        int timeout = Integer.parseInt(args.getOrDefault("decompile_timeout", "60"));
        if (timeout < 1) throw new IllegalArgumentException("StackmapExport: decompile_timeout must be at least 1 second");

        ProjectLocator locator = getState().getProject().getProjectLocator();
        File target = args.containsKey("out")
            ? new File(args.get("out"))
            : new File(new File(locator.getLocation(), locator.getName() + ".stackmap"),
                currentProgram.getDomainFile().getPathname().replaceFirst("^/", "") + ".json");
        File parent = target.getAbsoluteFile().getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("StackmapExport: can't create " + parent);
        File tmp = new File(parent, target.getName() + ".tmp-" + ProcessHandle.current().pid());

        long started = System.currentTimeMillis();
        try (JsonWriter jw = new JsonWriter(new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 20))) {
            w = jw;
            w.beginObject();
            w.name("format_version").value(FORMAT_VERSION);
            header(locator, timeout);
            memoryBlocks();
            Set<Long> stringAddresses = strings();
            pointerWords(stringAddresses);
            types();
            instructions();
            functions(timeout);
            w.name("export_seconds").value((System.currentTimeMillis() - started) / 1000.0);
            w.endObject();
        } catch (Exception e) {
            tmp.delete();
            throw e;
        }
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        println("StackmapExport: wrote " + target.getAbsolutePath() + " in " + (System.currentTimeMillis() - started) / 1000 + "s");
    }

    private void header(ProjectLocator locator, int timeout) throws Exception {
        w.name("exporter").beginObject();
        w.name("script").value("StackmapExport");
        w.name("ghidra_version").value(Application.getApplicationVersion());
        w.name("exported_at").value(Instant.now().toString());
        w.name("decompile_timeout_seconds").value(timeout);
        w.endObject();

        w.name("project").beginObject();
        w.name("location").value(locator.getLocation());
        w.name("name").value(locator.getName());
        w.name("gpr").value(locator.getMarkerFile().getAbsolutePath());
        w.endObject();

        programDatabase(locator);

        w.name("program").beginObject();
        w.name("path").value(currentProgram.getDomainFile().getPathname());
        w.name("name").value(currentProgram.getName());
        w.name("executable_path").value(currentProgram.getExecutablePath());
        w.name("executable_format").value(currentProgram.getExecutableFormat());
        w.name("language").value(currentProgram.getLanguageID().getIdAsString());
        w.name("compiler").value(currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString());
        w.name("image_base").value(addr(currentProgram.getImageBase()));
        w.name("pointer_size").value(currentProgram.getDefaultPointerSize());
        w.name("big_endian").value(currentProgram.getMemory().isBigEndian());
        w.name("info").beginObject();
        Options info = currentProgram.getOptions(Program.PROGRAM_INFO);
        for (String name : info.getOptionNames()) w.name(name).value(info.getValueAsString(name));
        w.endObject();
        w.endObject();
    }

    /**
     * The program's own database file, which is how stackmap tells a stale export from a fresh one:
     * saving a program writes the next `db.<N>.gbf` in its folder, while opening a project read-only
     * (what this export does) leaves the .gbf files alone but does rewrite the project's index files.
     *
     * The folder is found by this program's file id in `idata/~index.dat`, whose lines are
     * `<id>:<name>:<fileID>` under a folder-path line. src/adapters/ghidra/project.ts repeats this
     * lookup at read time; change both together.
     */
    private void programDatabase(ProjectLocator locator) throws Exception {
        String fileId = currentProgram.getDomainFile().getFileID();
        if (fileId == null || fileId.isBlank()) throw new IllegalStateException("StackmapExport: the program has no file id, so its database can't be identified");
        File idata = new File(new File(locator.getLocation(), locator.getName() + ".rep"), "idata");
        File index = new File(idata, "~index.dat");
        if (!index.isFile()) throw new IllegalStateException("StackmapExport: " + index + " is missing, so the program's database can't be found");
        String id = null;
        for (String line : Files.readAllLines(index.toPath(), StandardCharsets.UTF_8)) {
            String[] parts = line.trim().split(":");
            if (parts.length == 3 && parts[2].equals(fileId)) {
                id = parts[0];
                break;
            }
        }
        if (id == null) throw new IllegalStateException("StackmapExport: no entry for file id " + fileId + " in " + index);
        File dir = new File(new File(idata, id.substring(0, 2)), "~" + id + ".db");
        if (!dir.isDirectory()) throw new IllegalStateException("StackmapExport: the program's database folder " + dir + " is missing");
        File newest = null;
        long newestVersion = -1;
        for (File f : dir.listFiles()) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^db\\.(\\d+)\\.gbf$").matcher(f.getName());
            if (!m.matches()) continue;
            long version = Long.parseLong(m.group(1));
            if (version > newestVersion) {
                newestVersion = version;
                newest = f;
            }
        }
        if (newest == null) throw new IllegalStateException("StackmapExport: no db.<N>.gbf file in " + dir);
        w.name("program_database").beginObject();
        w.name("file_id").value(fileId);
        w.name("folder").value(id.substring(0, 2) + "/~" + id + ".db");
        w.name("file").value(newest.getName());
        w.name("version").value(newestVersion);
        w.name("size").value(newest.length());
        w.name("mtime_ms").value(newest.lastModified());
        w.endObject();
    }

    private void memoryBlocks() throws Exception {
        w.name("memory_blocks").beginArray();
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            w.beginObject();
            w.name("name").value(b.getName());
            w.name("start").value(addr(b.getStart()));
            w.name("end").value(addr(b.getEnd()));
            w.name("size").value(b.getSize());
            w.name("read").value(b.isRead());
            w.name("write").value(b.isWrite());
            w.name("execute").value(b.isExecute());
            w.name("initialized").value(b.isInitialized());
            w.name("overlay").value(b.isOverlay());
            w.endObject();
        }
        w.endArray();
    }

    /** Shortest NUL-terminated printable-ASCII run recorded as an undefined string. */
    static final int MIN_UNDEFINED_STRING = 4;

    private boolean scannable(MemoryBlock b) {
        return b.isInitialized() && !b.isExecute() && !b.isOverlay();
    }

    private byte[] blockBytes(MemoryBlock b) throws Exception {
        long size = b.getSize();
        if (size > Integer.MAX_VALUE - 8) {
            throw new IllegalStateException("StackmapExport: block " + b.getName() + " is " + size + " bytes, too large to scan");
        }
        byte[] buf = new byte[(int) size];
        int n = b.getBytes(b.getStart(), buf, 0, buf.length);
        if (n != buf.length) throw new IllegalStateException("StackmapExport: read " + n + " of " + size + " bytes of block " + b.getName());
        return buf;
    }

    /**
     * Strings: every defined data item with a string value ("defined": true), then every NUL-terminated
     * run of at least MIN_UNDEFINED_STRING printable ASCII bytes in a scannable block that no defined
     * data covers ("defined": false). Analysis leaves many strings undefined; a pointer to one is still a
     * reference to it. Returns the default-space offsets of both kinds for the pointer scan.
     */
    private Set<Long> strings() throws Exception {
        Set<Long> offsets = new HashSet<>();
        Listing listing = currentProgram.getListing();
        w.name("undefined_string_min_length").value(MIN_UNDEFINED_STRING);
        w.name("strings").beginArray();
        DataIterator it = listing.getDefinedData(true);
        while (it.hasNext()) {
            monitor.checkCancelled();
            Data d = it.next();
            if (!d.hasStringValue()) continue;
            Object v = d.getValue();
            w.beginObject();
            w.name("address").value(addr(d.getAddress()));
            w.name("value").value(v == null ? null : v.toString());
            w.name("length").value(d.getLength());
            w.name("type").value(d.getDataType().getName());
            w.name("defined").value(true);
            w.endObject();
            if (d.getAddress().getAddressSpace().equals(currentProgram.getAddressFactory().getDefaultAddressSpace())) {
                offsets.add(d.getAddress().getOffset());
            }
        }
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            if (!scannable(b)) continue;
            monitor.checkCancelled();
            byte[] buf = blockBytes(b);
            int start = -1;
            for (int i = 0; i < buf.length; i++) {
                int c = buf[i] & 0xff;
                if (c >= 0x20 && c < 0x7f) {
                    if (start < 0) start = i;
                    continue;
                }
                if (c == 0 && start >= 0 && i - start >= MIN_UNDEFINED_STRING) {
                    Address a = b.getStart().add(start);
                    Data covering = listing.getDefinedDataContaining(a);
                    if (covering == null) {
                        w.beginObject();
                        w.name("address").value(addr(a));
                        w.name("value").value(new String(buf, start, i - start, StandardCharsets.US_ASCII));
                        w.name("length").value(i - start + 1);
                        w.name("type").nullValue();
                        w.name("defined").value(false);
                        w.endObject();
                        offsets.add(a.getOffset());
                    }
                }
                start = -1;
            }
        }
        w.endArray();
        return offsets;
    }

    /**
     * Aligned 4-byte words (and 8-byte words when pointers are 8 bytes) in initialized, non-executable
     * blocks whose value is the address of a string: one pointer hop to a string, whether or not Ghidra
     * made a reference of it. Executable blocks are not scanned; the list says which were. An 8-byte word
     * whose upper half is zero has the same value as one of its 4-byte halves, which is already listed,
     * so 8-byte words are listed only when the upper half is non-zero.
     */
    private void pointerWords(Set<Long> targets) throws Exception {
        boolean big = currentProgram.getMemory().isBigEndian();
        int ptr = currentProgram.getDefaultPointerSize();
        w.name("pointer_scan").beginObject();
        w.name("widths").beginArray().value(4);
        if (ptr == 8) w.value(8);
        w.endArray();
        w.name("blocks_scanned").beginArray();
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            if (scannable(b)) w.value(b.getName());
        }
        w.endArray();
        w.endObject();
        // A top-level array, like the other long sections, so a reader can stream it one hit at a time.
        w.name("pointer_hits").beginArray();
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            if (!scannable(b)) continue;
            monitor.checkCancelled();
            long base = b.getStart().getOffset();
            byte[] buf = blockBytes(b);
            int n = buf.length;
            for (int i = (int) ((4 - base % 4) % 4); i + 4 <= n; i += 4) {
                long v4 = word(buf, i, big);
                if (v4 != 0 && targets.contains(v4)) hit(base + i, v4, 4);
                if (ptr == 8 && (base + i) % 8 == 0 && i + 8 <= n) {
                    long next = word(buf, i + 4, big);
                    long upper = big ? v4 : next;
                    long v8 = big ? (v4 << 32) | next : (next << 32) | v4;
                    if (upper != 0 && targets.contains(v8)) hit(base + i, v8, 8);
                }
            }
        }
        w.endArray();
    }

    private static long word(byte[] b, int i, boolean big) {
        return big
            ? ((b[i] & 0xffL) << 24) | ((b[i + 1] & 0xffL) << 16) | ((b[i + 2] & 0xffL) << 8) | (b[i + 3] & 0xffL)
            : ((b[i + 3] & 0xffL) << 24) | ((b[i + 2] & 0xffL) << 16) | ((b[i + 1] & 0xffL) << 8) | (b[i] & 0xffL);
    }

    private void hit(long at, long target, int width) throws Exception {
        w.beginObject();
        w.name("address").value(hex(at));
        w.name("target").value(hex(target));
        w.name("width").value(width);
        w.endObject();
    }

    private void types() throws Exception {
        DataTypeManager dtm = currentProgram.getDataTypeManager();
        w.name("types").beginArray();
        java.util.Iterator<Composite> it = dtm.getAllComposites();
        while (it.hasNext()) {
            monitor.checkCancelled();
            Composite c = it.next();
            w.beginObject();
            w.name("path").value(c.getPathName());
            w.name("name").value(c.getName());
            w.name("kind").value(c instanceof Union ? "union" : c instanceof Structure ? "struct" : "composite");
            w.name("size").value(c.getLength());
            w.name("zero_length").value(c.isZeroLength());
            w.name("alignment").value(c.getAlignment());
            w.name("packing_enabled").value(c.isPackingEnabled());
            w.name("explicit_packing").value(c.hasExplicitPackingValue() ? c.getExplicitPackingValue() : -1);
            w.name("description").value(c.getDescription());
            SourceArchive src = c.getSourceArchive();
            w.name("source_archive").value(src == null ? null : src.getName());
            w.name("fields").beginArray();
            for (DataTypeComponent m : c.getDefinedComponents()) {
                w.beginObject();
                w.name("name").value(m.getFieldName());
                w.name("offset").value(m.getOffset());
                w.name("size").value(m.getLength());
                DataType t = m.getDataType();
                w.name("type").value(t.getName());
                w.name("type_path").value(t.getPathName());
                if (m.isBitFieldComponent() && t instanceof BitFieldDataType) {
                    BitFieldDataType bf = (BitFieldDataType) t;
                    w.name("type").value(bf.getBaseDataType().getName());
                    w.name("bit_offset").value(bf.getBitOffset());
                    w.name("bit_size").value(bf.getDeclaredBitSize());
                }
                w.name("comment").value(m.getComment());
                w.endObject();
            }
            w.endArray();
            w.endObject();
        }
        w.endArray();
    }

    /** Every instruction: [address, containing function entry or null, text, [scalars], [[to, ref type]...]]. */
    private void instructions() throws Exception {
        Listing listing = currentProgram.getListing();
        w.name("instructions").beginArray();
        InstructionIterator it = listing.getInstructions(true);
        while (it.hasNext()) {
            monitor.checkCancelled();
            Instruction ins = it.next();
            w.beginArray();
            w.value(addr(ins.getAddress()));
            Function f = listing.getFunctionContaining(ins.getAddress());
            w.value(f == null ? null : addr(f.getEntryPoint()));
            w.value(ins.toString());
            w.beginArray();
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (o instanceof Scalar) w.value(hex(((Scalar) o).getUnsignedValue()));
                }
            }
            w.endArray();
            w.beginArray();
            for (Reference r : ins.getReferencesFrom()) {
                w.beginArray().value(addr(r.getToAddress())).value(r.getReferenceType().getName()).endArray();
            }
            w.endArray();
            w.endArray();
        }
        w.endArray();
    }

    private void functions(int timeout) throws Exception {
        DecompInterface decomp = new DecompInterface();
        if (!decomp.openProgram(currentProgram)) {
            throw new IllegalStateException("StackmapExport: the decompiler would not open the program: " + decomp.getLastMessage());
        }
        Listing listing = currentProgram.getListing();
        int ok = 0, failed = 0, timedOut = 0, total = 0;
        long functionBytes = 0;
        w.name("functions").beginArray();
        try {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                monitor.checkCancelled();
                total++;
                functionBytes += f.getBody().getNumAddresses();
                w.beginObject();
                w.name("name").value(f.getName(true));
                w.name("entry").value(addr(f.getEntryPoint()));
                w.name("size").value(f.getBody().getNumAddresses());
                w.name("body").beginArray();
                for (AddressRange r : f.getBody().getAddressRanges()) w.beginArray().value(addr(r.getMinAddress())).value(addr(r.getMaxAddress())).endArray();
                w.endArray();
                w.name("signature").value(f.getPrototypeString(false, false));
                w.name("calling_convention").value(f.getCallingConventionName());
                w.name("noreturn").value(f.hasNoReturn());
                w.name("thunk_of").value(f.isThunk() && f.getThunkedFunction(false) != null ? addr(f.getThunkedFunction(false).getEntryPoint()) : null);
                w.name("source").value(f.getSymbol().getSource().toString());

                // Every reference to the entry: [from, containing function entry or null, ref type, is a call].
                w.name("refs_to").beginArray();
                for (Reference r : getReferencesTo(f.getEntryPoint())) {
                    Function from = listing.getFunctionContaining(r.getFromAddress());
                    w.beginArray()
                        .value(addr(r.getFromAddress()))
                        .value(from == null ? null : addr(from.getEntryPoint()))
                        .value(r.getReferenceType().getName())
                        .value(r.getReferenceType().isCall())
                        .endArray();
                }
                w.endArray();

                w.name("callees").beginArray();
                for (Function c : f.getCalledFunctions(monitor)) w.value(addr(c.getEntryPoint()));
                w.endArray();

                int unresolved = 0;
                for (Instruction ins : listing.getInstructions(f.getBody(), true)) {
                    if (ins.getFlowType().isCall() && ins.getFlowType().isComputed()) {
                        boolean resolved = false;
                        for (Reference r : ins.getReferencesFrom()) if (r.getReferenceType().isCall()) resolved = true;
                        if (!resolved) unresolved++;
                    }
                }
                w.name("computed_calls_unresolved").value(unresolved);

                if (f.isExternal() || f.isThunk()) {
                    w.name("decompile").value("not_applicable");
                    w.name("pseudocode").nullValue();
                } else {
                    DecompileResults res = decomp.decompileFunction(f, timeout, monitor);
                    if (res != null && res.decompileCompleted()) {
                        ok++;
                        w.name("decompile").value("ok");
                        w.name("pseudocode").value(res.getDecompiledFunction().getC());
                    } else {
                        boolean isTimeout = res != null && res.isTimedOut();
                        String why = res == null ? "the decompiler returned no result" : res.getErrorMessage();
                        if (res != null && (why == null || why.isBlank())) {
                            why = "the decompiler gave no message (failed to start: " + res.failedToStart()
                                + ", cancelled: " + res.isCancelled() + ", valid: " + res.isValid() + ")";
                        }
                        if (isTimeout) timedOut++; else failed++;
                        w.name("decompile").value(isTimeout ? "timeout" : "failed");
                        w.name("decompile_error").value(why);
                        w.name("pseudocode").nullValue();
                    }
                }
                w.endObject();
                if (total % 1000 == 0) {
                    w.flush();
                    println("StackmapExport: " + total + " functions");
                }
            }
        } finally {
            decomp.dispose();
        }
        w.endArray();
        w.name("counts").beginObject();
        w.name("functions").value(total);
        w.name("function_bytes").value(functionBytes);
        w.name("decompiled").value(ok);
        w.name("decompile_failed").value(failed);
        w.name("decompile_timeout").value(timedOut);
        w.endObject();
    }
}
