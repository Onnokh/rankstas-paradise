/**
 * The one stylesheet the rig needs, injected once per document.
 *
 * It carries no motion. Every shape and every transform comes from script, so
 * there is no second owner that could fight the render loop or leave a CSS
 * transition running across a state the springs have already left.
 */

const STYLE_ID = "rk-mascot-styles";

export function ensureStylesheet(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.rk-root{display:block;width:100%;height:auto;overflow:visible}
.rk-root *{transform-box:view-box}
`.trim();
  doc.head.append(style);
}
