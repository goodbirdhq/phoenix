/** The longest selected label must fit without changing mode between destinations. */
export function footerShowsLabels(usableWidth: number, fontScale: number, longestLabelWidth = 146) {
  return usableWidth >= 5 * 44 + Math.max(44, longestLabelWidth * fontScale) + 5 * 4 + 24;
}
