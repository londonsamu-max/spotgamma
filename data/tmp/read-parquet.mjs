import { parquetRead } from 'hyparquet';
import { readFileSync } from 'node:fs';

const buf = readFileSync('data/tmp/trace-sample.parquet');
const ab = new ArrayBuffer(buf.length);
const view = new Uint8Array(ab);
for (let i = 0; i < buf.length; i++) view[i] = buf[i];

await parquetRead({
  file: ab,
  onComplete: (data) => {
    console.log('Rows:', data.length);
    if (data.length > 0) {
      console.log('Sample:', JSON.stringify(data[0]).slice(0, 300));
      console.log('Last:', JSON.stringify(data[data.length-1]).slice(0, 300));
    }
  }
});
