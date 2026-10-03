import { startPreview } from '../../scripts/serve.mjs';
export default async function setup() {
  const server = startPreview();
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  return async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); };
}
