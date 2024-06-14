const execSync = require('child_process').execSync;
const { INIT_CWD, PWD } = process.env;
const packageConfig = require('../package.json')
try {
  // const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  // console.log(`当前Git分支: ${currentBranch}`);
  const vue3verify = /^\^3.*.*/.test(packageConfig.dependencies.vue)
  const patchDir = vue3verify ? '--patch-dir patches-vue3' : '--patch-dir patches'

  if (!INIT_CWD || INIT_CWD === PWD || INIT_CWD.toString().replace(/\\/g, () => '/').indexOf(PWD) === 0) {
    const command = ['npx', ...process.argv.slice(2, process.argv.length), patchDir].join(' ');
    console.log('[command]', command);
    execSync(command, { stdio: 'inherit' });
  }
  
  process.exit(0);
} catch (error) {
  console.error(error);
}
