// The app serves its plugin bundle as an immutable snapshot from process
// start, so a freshly edited client.js is not what a live page runs. These
// helpers swap the picker's own segment of a served bundle for the checkout's
// file — the segment runs from the picker's `__ModuleLoader__.load` call to
// the next plugin's, and the swap fires whenever that segment differs from
// the checkout, byte for byte (a marker-based guard misfires once the served
// build carries an older "new enough" marker).
export const PICKER_MARK = "window.__ModuleLoader__.load({ id: 'dsh-model-picker'"
export const ANY_MARK = "window.__ModuleLoader__.load({ id: '"

/** The picker's segment of a served bundle, or null when it is not in there. */
export function pickerSegment(html) {
  const start = html.indexOf(PICKER_MARK)
  if (start === -1) return null
  const next = html.indexOf(ANY_MARK, start + ANY_MARK.length)
  return html.slice(start, next === -1 ? html.length : next)
}

/** The bundle with the checkout's picker segment in place of the served one. */
export function withCheckoutPicker(html, newClient) {
  const start = html.indexOf(PICKER_MARK)
  if (start === -1) return null
  const next = html.indexOf(ANY_MARK, start + ANY_MARK.length)
  return html.slice(0, start) + newClient + (next === -1 ? '' : html.slice(next))
}
