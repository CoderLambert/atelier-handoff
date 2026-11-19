/**
 * @file 接收桌面宿主的私有生命周期消息。
 * @implementation 在启动时仅接受版本匹配的配对请求，并发送结构化就绪或故障响应。
 * @updated 2026-11-20T02:00+08:00
 */
import {
  desktopHostDeadlines,
  desktopHostHelloSchema,
  desktopHostReplySchema,
  type DesktopHostHello,
  type DesktopHostReply,
} from '../shared/desktop-host.js';

export function receiveDesktopHost(): Promise<DesktopHostHello> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      clean();
      reject(new Error(reason));
    };
    const disconnected = () => fail('Desktop IPC disconnected before handshake.');
    const message = (input: unknown) => {
      const hello = desktopHostHelloSchema.safeParse(input);
      if (!hello.success) {
        fail('Incompatible desktop host protocol.');
        return;
      }
      clean();
      resolve(hello.data);
    };
    const clean = () => {
      clearTimeout(timer);
      process.off('disconnect', disconnected);
      process.off('message', message);
    };
    const timer = setTimeout(
      () => fail('Desktop IPC handshake timed out.'),
      desktopHostDeadlines.ready,
    );
    process.once('disconnect', disconnected);
    process.once('message', message);
    if (!process.connected) disconnected();
  });
}

export async function sendDesktopHost(reply: DesktopHostReply): Promise<void> {
  const message = desktopHostReplySchema.parse(reply);
  await new Promise<void>((resolve, reject) => {
    const send = process.send;
    if (!send || !process.connected) {
      reject(new Error('Desktop IPC disconnected.'));
      return;
    }
    send.call(process, message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}
