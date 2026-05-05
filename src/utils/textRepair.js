function brokenScore(text) {
  const value = String(text || "");
  const brokenMarkers = (value.match(/[ÃÂâåæçéèä][\u0080-\u00ff]?/g) || []).length;
  const replacements = (value.match(/\uFFFD/g) || []).length;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  return brokenMarkers * 3 + replacements * 4 - cjk;
}

export function repairText(value) {
  const text = String(value || "");
  if (!text) return "";

  try {
    const bytes = Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8").decode(bytes);
    return brokenScore(repaired) < brokenScore(text) ? repaired : text;
  } catch {
    return text;
  }
}
