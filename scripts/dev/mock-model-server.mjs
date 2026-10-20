#!/usr/bin/env node
/**
 * M3 验收专用：本地 OpenAI-compatible 模型桩（HTTPS）。
 * 仅用于证明 provider 测试 / model 发布 / copy 生成 / judge 调用链路；
 * 不参与生产代码，密钥为本地自签临时证书。
 */
import https from 'node:https';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 8443);
const KEY = process.env.MOCK_TLS_KEY ?? '.tmp-m3/key.pem';
const CERT = process.env.MOCK_TLS_CERT ?? '.tmp-m3/cert.pem';

const key = readFileSync(KEY);
const cert = readFileSync(CERT);

const COPY_TEXT = '双面穿风衣 春秋新款 防风立领 通勤百搭';
const JUDGE_JSON = JSON.stringify({
  verdict: 'pass',
  severity: 'info',
  reason: '未发现与主数据冲突的硬事实，措辞合规',
  repair_hint: '',
  evidence_refs: [],
  confidence: 0.92,
});

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = https.createServer({ key, cert }, (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url.startsWith('/models')) {
    send(res, 200, { object: 'list', data: [{ id: 'mock-chat', object: 'model' }] });
    return;
  }
  if (req.method === 'POST' && url.startsWith('/chat/completions')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let prompt = '';
      try {
        const body = JSON.parse(raw);
        prompt = (body.messages ?? [])
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n');
      } catch {
        prompt = '';
      }
      const isJudge = /JudgmentV1|verdict|判定|evidence_refs/.test(prompt);
      const content = isJudge ? JUDGE_JSON : COPY_TEXT;
      send(res, 200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        model: 'mock-chat',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 180, completion_tokens: isJudge ? 60 : 24, total_tokens: 240 },
      });
    });
    return;
  }
  send(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-model] https://127.0.0.1:${PORT}`);
});
