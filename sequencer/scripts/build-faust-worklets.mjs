// Compile shared Faust DSP sources from ../vst/glitch/dsp/ into a precompiled
// triple under sequencer/public/worklets/faust/: WASM module, meta JSON, and
// a self-contained AudioWorkletProcessor JS file. The runtime (sequencer/
// src/audio/reverb.ts) loads the processor via `addModule()` and constructs a
// plain AudioWorkletNode — no @grame/faustwasm in the runtime bundle.
//
// Why we generate the processor JS at build time instead of letting the
// runtime do it (via `FaustMonoDspGenerator.createNode()`): the Faust runtime
// builds the processor source by stringifying its own class definitions and
// referencing them by identifier name. After Vite's minifier renames those
// identifiers (e.g. `FaustBaseWebAudioDsp` → `Ut`) inside the main bundle,
// the stringified class bodies still contain the minified references, but
// the worklet's Blob URL evaluates in a fresh scope where those identifiers
// don't exist → `Ut is not defined`. Generating the processor JS in Node,
// outside any minifier, sidesteps the problem entirely.
//
// Run via `npm run build-faust` from the sequencer/ directory. The emitted
// assets are committed so the Vite dev/build pipeline and the Netlify deploy
// don't depend on the Faust toolchain.
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
  FaustBaseWebAudioDsp,
  FaustMonoWebAudioDsp,
  FaustWasmInstantiator,
  FaustDspInstance,
  Soundfile,
  WasmAllocator,
  getFaustAudioWorkletProcessor,
} from '@grame/faustwasm/dist/esm/index.js';

// FaustSensors and the two Communicator classes are not in the package's
// public exports but ARE referenced inside the embedded worklet processor.
// Extract their source text directly from the package's bundle (their
// declarations are stable `var ClassName = class ... { ... };` blocks).
const FAUSTWASM_SOURCE = await fs.readFile(
  path.join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'node_modules',
    '@grame',
    'faustwasm',
    'dist',
    'esm',
    'index.js',
  ),
  'utf8',
);

function extractClassSource(name) {
  const start = FAUSTWASM_SOURCE.indexOf(`var ${name} = class`);
  if (start === -1) throw new Error(`internal class "${name}" not found in @grame/faustwasm bundle`);
  // Walk balanced braces from the opening { of the class body.
  let i = FAUSTWASM_SOURCE.indexOf('{', start);
  let depth = 1;
  i += 1;
  while (depth > 0 && i < FAUSTWASM_SOURCE.length) {
    const ch = FAUSTWASM_SOURCE[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  // Consume optional trailing `;`.
  while (i < FAUSTWASM_SOURCE.length && /\s/.test(FAUSTWASM_SOURCE[i])) i += 1;
  if (FAUSTWASM_SOURCE[i] === ';') i += 1;
  return FAUSTWASM_SOURCE.slice(start, i);
}

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

function buildProcessorSource(name, dspMeta) {
  // Mirrors the template inside FaustMonoDspGenerator.createNode in
  // node_modules/@grame/faustwasm/dist/esm/index.js. The runtime version
  // sets `processorName = factory.shaKey || name`; we use the bare name
  // since the .wasm is shipped as a separate asset and the AudioWorkletNode
  // constructor only cares about the registered processor name.
  //
  // Publicly-exported classes are pulled via `.toString()` on their imports
  // (works because the package's own build leaves internal references
  // unminified — see `grep "new _FaustSensors"`). The internal-only classes
  // are extracted directly from the package's bundled source text.
  const faustData = {
    processorName: name,
    dspName: name,
    dspMeta,
    poly: false,
  };
  return `
const faustData = ${JSON.stringify(faustData)};
var FaustDspInstance = ${FaustDspInstance.toString()};
var FaustBaseWebAudioDsp = ${FaustBaseWebAudioDsp.toString()};
var FaustMonoWebAudioDsp = ${FaustMonoWebAudioDsp.toString()};
var FaustWasmInstantiator = ${FaustWasmInstantiator.toString()};
var Soundfile = ${Soundfile.toString()};
var WasmAllocator = ${WasmAllocator.toString()};
${extractClassSource('FaustSensors')}
${extractClassSource('FaustAudioWorkletCommunicator')}
${extractClassSource('FaustAudioWorkletProcessorCommunicator')}
const dependencies = {
  FaustBaseWebAudioDsp,
  FaustMonoWebAudioDsp,
  FaustWasmInstantiator,
  FaustAudioWorkletProcessorCommunicator,
};
(${getFaustAudioWorkletProcessor.toString()})(dependencies, faustData);
`;
}

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
    const meta = JSON.parse(factory.json);
    const processorSource = buildProcessorSource(name, meta);

    await fs.writeFile(path.join(OUT_DIR, `${name}-module.wasm`), wasm);
    await fs.writeFile(path.join(OUT_DIR, `${name}-meta.json`), factory.json);
    await fs.writeFile(path.join(OUT_DIR, `${name}-processor.js`), processorSource);
    console.log(
      `✓ ${name}: ${wasm.byteLength}B wasm, ${factory.json.length}B json, ${processorSource.length}B processor`,
    );
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
