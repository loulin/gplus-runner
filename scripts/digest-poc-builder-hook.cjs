module.exports = async function sign(configuration) {
  if (configuration.hash !== 'sha256') throw new Error('Digest POC requires SHA256');
  const { signRound } = require(process.env.GPLUS_DIGEST_POC_MODULE);
  await signRound([configuration.path], configuration.path.endsWith('__uninstaller.exe') ? 'nsis-uninstaller' : 'nsis-installer');
};
