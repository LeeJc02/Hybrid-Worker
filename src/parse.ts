export function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!cleaned || cleaned.startsWith("-")) throw new Error(`Invalid worker name: ${name}`);
  return cleaned;
}

export function parseNamedValue(value: string, flag: string): [string, string] {
  const index = value.indexOf(":");
  if (index < 0) throw new Error(`${flag} must be NAME:VALUE`);
  return [safeName(value.slice(0, index)), value.slice(index + 1)];
}
