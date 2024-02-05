const execSync = require('child_process').execSync;
const { INIT_CWD, PWD } = process.env;

if (!INIT_CWD || INIT_CWD === PWD || INIT_CWD.toString().replace(/\\/g, () => '/').indexOf(PWD) === 0) {
  const command = ['npx', ...process.argv.slice(2, process.argv.length)].join(' ');
  execSync(command, { stdio: 'inherit' });
}

process.exit(0);