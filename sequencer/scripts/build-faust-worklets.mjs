// Compile shared Faust DSP sources from ../vst/glitch/dsp/ into precompiled
// WASM + meta JSON pairs under sequencer/public/worklets/faust/. The runtime
// (sequencer/src/audio/reverb.ts) fetches the pair and instantiates a
// FaustMonoAudioWorkletNode via @grame/faustwasm — no libfaust at runtime.
//
// Run via `npm run build-faust` from the sequencer/ directory. The emitted
// assets are committed to the repo so the Vite dev/build pipeline and the
// Netlify deploy don't depend on the Faust toolchain.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Import the ESM build explicitly — the package's `main` field points at a
// CJS IIFE bundle that node treats as a module-with-no-exports under
// `"type": "module"`, and the `module` field isn't honored by node's ESM
// resolver.
import {
  instantiateFaustModuleFromFile,
  LibFaust,
  FaustCompiler,
  FaustMonoDspGenerator,
} from '@grame/faustwasm/dist/esm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEQ_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SEQ_ROOT, '..');

const TARGETS = [
  { name: 'reverb', dsp: 'vst/glitch/dsp/reverb.dsp' },
];

const OUT_DIR = path.join(SEQ_ROOT, 'public', 'worklets', 'faust');
const LIBFAUST_PATH = path.join(
  SEQ_ROOT,
  'node_modules',
  '@grame',
  'faustwasm',
  'libfaust-wasm',
  'libfaust-wasm.js',
);

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const faustModule = await instantiateFaustModuleFromFile(LIBFAUST_PATH);
  const libFaust = new LibFaust(faustModule);
  const compiler = new FaustCompiler(libFaust);
  console.log(`Faust ${compiler.version()}`);

  for (const { name, dsp } of TARGETS) {
    const dspPath = path.join(REPO_ROOT, dsp);
    const code = await fs.readFile(dspPath, 'utf8');
    const generator = new FaustMonoDspGenerator();
    const includeDir = path.dirname(dspPath);
    const result = await generator.compile(compiler, name, code, `-I ${includeDir} -ftz 2`);
    if (!result || !generator.factory) {
      throw new Error(`Faust compile failed for ${name}`);
    }
    const factory = generator.factory;
    const wasm = Buffer.from(factory.code);
    await fs.writeFile(path.join(OUT_DIR, `${name}-module.wasm`), wasm);
    await fs.writeFile(path.join(OUT_DIR, `${name}-meta.json`), factory.json);
    console.log(
      `✓ ${name}: ${wasm.byteLength} bytes wasm, ${factory.json.length} bytes json`,
    );
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
