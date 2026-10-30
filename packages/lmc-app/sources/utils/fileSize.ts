export function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024) + ' KiB'; }
