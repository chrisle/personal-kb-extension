export function log(tag: string, msg: string): void {
  process.stderr.write(`[${tag}] ${msg}\n`);
}
