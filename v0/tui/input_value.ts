export const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
export const scalars = (text: string): string[] => [...text];
export const scalarIndexToOffset = (text: string, index: number): number => {
  let offset = 0, scalar = 0;
  for (const character of text) {
    if (scalar >= index) break;
    offset += character.length;
    scalar += 1;
  }
  return offset;
};
export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;
