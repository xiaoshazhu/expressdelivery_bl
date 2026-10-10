import { randomBytes } from 'node:crypto';
import { ApiError } from './service.mjs';
import { BaseGateway } from './base-gateway.mjs';
export function createSessions({ now = Date.now, gatewayFactory = config => new BaseGateway(config) } = {}) {
  const sessions = new Map();
  const cleanup = () => { for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key); };
  const timer = setInterval(cleanup, 60000); timer.unref();
  return {
    async connect(data) {
      cleanup();
      if (sessions.size >= 1000) throw new ApiError(429, 'SESSION_LIMIT', '会话已满，请稍后再试');
      if (!data || !['demo', 'feishu'].includes(data.mode)) throw new ApiError(400, 'MODE', '请选择演示模式或飞书模式');
      const gateway = data.mode === 'feishu' ? gatewayFactory(data) : null;
      const fields = gateway ? await gateway.fields() : [];
      const token = randomBytes(32).toString('hex'); const expiresAt = now() + 3600000;
      sessions.set(token, { gateway, expiresAt, mode: data.mode });
      return { token, expiresAt, mode: data.mode, fields };
    },
    get(token) {
      cleanup(); const session = sessions.get(token);
      if (!session) throw new ApiError(401, 'SESSION_EXPIRED', '请先连接；会话失效后需重新输入飞书授权码');
      return session;
    },
    remove(token) { sessions.delete(token); },
    close() { clearInterval(timer); sessions.clear(); },
  };
}
