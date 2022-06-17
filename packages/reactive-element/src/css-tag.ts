/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * Whether the current browser supports `adoptedStyleSheets`.
 */
export const supportsAdoptingStyleSheets =
  window.ShadowRoot &&
  (window.ShadyCSS === undefined || window.ShadyCSS.nativeShadow) &&
  'adoptedStyleSheets' in Document.prototype &&
  'replace' in CSSStyleSheet.prototype;

/**
 * A CSSResult or native CSSStyleSheet.
 *
 * In browsers that support constructible CSS style sheets, CSSStyleSheet
 * object can be used for styling along side CSSResult from the `css`
 * template tag.
 */
export type CSSResultOrNative = CSSResult | CSSStyleSheet;

export type CSSResultArray = Array<CSSResultOrNative | CSSResultArray>;

/**
 * A single CSSResult, CSSStyleSheet, or an array or nested arrays of those.
 */
export type CSSResultGroup = CSSResultOrNative | CSSResultArray;

const constructionToken = Symbol();

/**
 * A container for a string of CSS text, that may be used to create a CSSStyleSheet.
 *
 * CSSResult is the return value of `css`-tagged template literals and
 * `unsafeCSS()`. In order to ensure that CSSResults are only created via the
 * `css` tag and `unsafeCSS()`, CSSResult cannot be constructed directly.
 */
export class CSSResult {
  // This property needs to remain unminified.
  ['_$cssResult$'] = true;
  readonly cssText: string;
  private _styleSheet?: CSSStyleSheet;

  private constructor(cssText: string, safeToken: symbol) {
    if (safeToken !== constructionToken) {
      throw new Error(
        'CSSResult is not constructable. Use `unsafeCSS` or `css` instead.'
      );
    }
    this.cssText = cssText;
  }

  // This is a getter so that it's lazy. In practice, this means stylesheets
  // are not created until the first element instance is made.
  get styleSheet(): CSSStyleSheet | undefined {
    // If `supportsAdoptingStyleSheets` is true then we assume CSSStyleSheet is
    // constructable.
    if (supportsAdoptingStyleSheets && this._styleSheet === undefined) {
      (this._styleSheet = new CSSStyleSheet()).replaceSync(this.cssText);
    }
    return this._styleSheet;
  }

  toString(): string {
    return this.cssText;
  }
}

type ConstructableCSSResult = CSSResult & {
  new (cssText: string, safeToken: symbol): CSSResult;
};

// Type guard for CSSResult
const isCSSResult = (value: unknown): value is CSSResult =>
  (value as CSSResult)['_$cssResult$'] === true;

// Type guard for style element
const isStyleEl = (
  value: unknown
): value is HTMLStyleElement | HTMLLinkElement => {
  const {localName} = value as HTMLElement;
  return localName === 'style' || localName === 'link';
};

const textFromCSSResult = (value: CSSResultGroup | number) => {
  // This property needs to remain unminified.
  if (isCSSResult(value)) {
    return value.cssText;
  } else if (typeof value === 'number') {
    return value;
  } else {
    throw new Error(
      `Value passed to 'css' function must be a 'css' function result: ` +
        `${value}. Use 'unsafeCSS' to pass non-literal values, but take care ` +
        `to ensure page security.`
    );
  }
};

/**
 * Wrap a value for interpolation in a {@linkcode css} tagged template literal.
 *
 * This is unsafe because untrusted CSS text can be used to phone home
 * or exfiltrate data to an attacker controlled site. Take care to only use
 * this with trusted input.
 */
export const unsafeCSS = (value: unknown) =>
  new (CSSResult as ConstructableCSSResult)(
    typeof value === 'string' ? value : String(value),
    constructionToken
  );

/**
 * A template literal tag which can be used with LitElement's
 * {@linkcode LitElement.styles} property to set element styles.
 *
 * For security reasons, only literal string values and number may be used in
 * embedded expressions. To incorporate non-literal values {@linkcode unsafeCSS}
 * may be used inside an expression.
 */
export const css = (
  strings: TemplateStringsArray,
  ...values: (CSSResultGroup | number)[]
): CSSResult => {
  const cssText =
    strings.length === 1
      ? strings[0]
      : values.reduce(
          (acc, v, idx) => acc + textFromCSSResult(v) + strings[idx + 1],
          strings[0]
        );
  return new (CSSResult as ConstructableCSSResult)(cssText, constructionToken);
};

// Markers used to determine where style elements have been inserted in the
// shadowRoot so that they can be easily updated.
const styleMarkersMap = new WeakMap<ShadowRoot, [Comment, Comment]>();
const getStyleMarkers = (renderRoot: ShadowRoot) => {
  let markers = styleMarkersMap.get(renderRoot);
  if (markers === undefined) {
    const start = renderRoot.appendChild(document.createComment(''));
    const end = renderRoot.appendChild(document.createComment(''));
    styleMarkersMap.set(renderRoot, (markers = [start, end]));
  }
  return markers;
};

/**
 * Clears any nodes between the given nodes. Used to remove style elements that
 * have been inserted via `adoptStyles`. This allows ensures any previously
 * applied styling is not re-applied.
 */
const removeNodesBetween = (start: Node, end: Node) => {
  let n = start.nextSibling;
  while (n && n !== end) {
    const next = n.nextSibling;
    n.remove();
    n = next;
  }
};

/**
 * Applies the optional globally set `litNonce` to an element.
 */
const applyNonce = (el: HTMLElement) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonce = (window as any)['litNonce'];
  if (nonce !== undefined) {
    el.setAttribute('nonce', nonce);
  }
};

/**
 * Applies the given styles to a `shadowRoot`. When Shadow DOM is
 * available but `adoptedStyleSheets` is not, styles are appended to the
 * `shadowRoot` to [mimic spec behavior](https://wicg.github.io/construct-stylesheets/#using-constructed-stylesheets).
 * Note, when shimming is used, any styles that are subsequently placed into
 * the shadowRoot should be placed *before* any shimmed adopted styles. This
 * will match spec behavior that gives adopted sheets precedence over styles in
 * shadowRoot.
 *
 * The given styles can be a CSSResult or CSSStyleSheet. If a CSSStyleSheet is
 * supplied, it should be a constructed stylesheet.
 *
 * Optionally preserves any existing adopted styles, sheets or elements.
 */
export const adoptStyles = (
  renderRoot: ShadowRoot,
  styles: CSSResultOrNative[],
  preserveExisting = false
) => {
  // Get a set of sheets and elements to apply.
  const elements: Array<HTMLStyleElement | HTMLLinkElement> = [];
  const sheets: CSSStyleSheet[] = styles
    .map((s) => getSheetOrElementToApply(s))
    .filter((s): s is CSSStyleSheet => !(isStyleEl(s) && elements.push(s)));
  // By default, clear any existing styling.
  if (!preserveExisting) {
    if ((renderRoot as ShadowRoot).adoptedStyleSheets) {
      (renderRoot as ShadowRoot).adoptedStyleSheets = [];
    }
    if (styleMarkersMap.has(renderRoot)) {
      removeNodesBetween(...getStyleMarkers(renderRoot));
    }
  }
  // Apply sheets, Note, this are only set if `adoptedStyleSheets` is supported.
  if (sheets.length) {
    (renderRoot as ShadowRoot).adoptedStyleSheets = sheets;
  }
  // Apply any style elements
  if (elements.length) {
    const [, end] = getStyleMarkers(renderRoot);
    end.before(...elements);
  }
};

/**
 * Gets compatible style object (sheet or element) which can be applied to a
 * shadowRoot.
 */
const getSheetOrElementToApply = (styling: CSSResultOrNative) => {
  // Converts to a CSSResult when `adoptedStyleSheets` is unsupported.
  if (styling instanceof CSSStyleSheet) {
    styling = getCompatibleStyle(styling);
  }
  // If it's a CSSResult, return the stylesheet or a style element
  if (isCSSResult(styling)) {
    if (styling.styleSheet !== undefined) {
      return styling.styleSheet;
    } else {
      const style = document.createElement('style');
      style.textContent = styling.cssText;
      applyNonce(style);
      return style;
    }
  }
  // Otherwise, it should be a constructed stylesheet
  return styling;
};

const cssResultFromStyleSheet = (sheet: CSSStyleSheet) => {
  let cssText = '';
  for (const rule of sheet.cssRules) {
    cssText += rule.cssText;
  }
  return unsafeCSS(cssText);
};

/**
 * Given a CSSStylesheet or CSSResult, converts from CSSStyleSheet to CSSResult
 * if the browser does not support `adoptedStyleSheets`.
 */
export const getCompatibleStyle = supportsAdoptingStyleSheets
  ? (s: CSSResultOrNative) => s
  : (s: CSSResultOrNative) =>
      s instanceof CSSStyleSheet ? cssResultFromStyleSheet(s) : s;
