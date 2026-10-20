/** t34 证据脚本用 provider：任意 external id 都返回一张确定性 PNG。 */
import type sharp from 'sharp';
import type { MediaProvider } from '../src/media/provider.js';

export function mediaDemoProvider(sharpFactory: typeof sharp): MediaProvider {
  return {
    async submit() {
      return { externalJobId: 'seed-retrieved' };
    },
    async poll() {
      return {
        status: 'succeeded',
        resultUrl: 'memory://seed',
        usage: { images: 1, seconds: 0, costCents: 4 },
      };
    },
    async fetch() {
      const bytes = await sharpFactory({
        create: { width: 1200, height: 1600, channels: 3, background: '#dde6ee' },
      })
        .png()
        .toBuffer();
      return { bytes, mime: 'image/png' };
    },
    async cancel() {
      return { supported: true };
    },
  };
}
