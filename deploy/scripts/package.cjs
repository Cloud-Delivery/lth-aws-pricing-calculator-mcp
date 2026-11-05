const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { applyOverrides } = require('./overrides.cjs');

async function main() {
  const deploy = path.resolve(__dirname, '..');
  const root = path.resolve(deploy, '..');
  const upstream = path.join(root, 'sample-aws-pricing-calculator-mcp');
  const staging = path.join(deploy, '.staging');
  const artifact = path.join(deploy, 'artifact');
  try {
    await fs.access(path.join(upstream, 'package.json'));
  } catch (error) {
    throw new Error('Upstream submodule unavailable. Run git submodule update --init --recursive.', { cause: error });
  }
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(artifact, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(artifact, { recursive: true });
  await fs.mkdir(path.join(artifact, 'server'), { recursive: true });
  await fs.cp(path.join(upstream, 'lib'), path.join(staging, 'lib'), { recursive: true });
  await fs.copyFile(path.join(upstream, 'mcp-server.js'), path.join(staging, 'mcp-server.js'));
  await fs.copyFile(path.join(upstream, 'package.json'), path.join(staging, 'package.json'));
  await fs.cp(path.join(upstream, 'catalog'), path.join(staging, 'catalog'), { recursive: true });
  const applied = await applyOverrides(staging, path.join(deploy, 'overrides'));
  const common = {
    bundle: true, platform: 'node', target: 'node24', format: 'cjs',
    logLevel: 'warning',
    nodePaths: [path.join(deploy, 'node_modules')],
  };
  const serverBuild = await esbuild.build({
    ...common, entryPoints: [path.join(staging, 'mcp-server.js')],
    outfile: path.join(artifact, 'server', 'mcp-server.cjs'),
    external: ['playwright', 'playwright-core'],
    metafile: true,
  });
  const inputPaths = Object.keys(serverBuild.metafile.inputs);
  if (inputPaths.some(input => [root, upstream].some(source =>
    path.resolve(input).startsWith(path.join(source, 'node_modules') + path.sep)))) {
    throw new Error('Packaging resolved upstream node_modules instead of isolated deployment dependencies');
  }
  for (const dependency of ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb']) {
    if (!inputPaths.some(input => input.replaceAll('\\', '/').includes(`node_modules/${dependency}/`))) {
      throw new Error(`Required dependency was not bundled: ${dependency}`);
    }
  }
  await esbuild.build({
    ...common, entryPoints: [path.join(deploy, 'runtime', 'handler.ts')],
    outfile: path.join(artifact, 'handler.js'),
  });
  await fs.cp(path.join(staging, 'catalog'), path.join(artifact, 'server', 'catalog'), { recursive: true });
  const files = await fs.readdir(path.join(artifact, 'server', 'catalog', 'services'));
  if (!files.some(file => file.endsWith('.json'))) throw new Error('Packaged catalog is empty');
  console.log(`Lambda artifact ready; catalog includes ${files.length} files; overrides: ${applied.join(', ')}. No upstream build executed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
