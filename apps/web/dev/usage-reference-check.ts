/** Run from the reference page to check the Paper geometry through every async state. */
export async function verifyUsageLayout() {
  await document.fonts.ready;
  const states = ["ready", "loading", "refreshing", "stale", "offline", "exhausted"];
  const expectedRows = [
    [116, 63],
    [229, 90],
    [325, 90],
    [421, 90],
    [517, 69],
    [592, 69],
  ];
  const results = [];
  const select = async (state: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
      (item) => item.textContent === state,
    );
    if (!button) throw new Error("Open /dev/usage-reference.html before running this check.");
    button.click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  try {
    for (const state of states) {
      await select(state);
      const sidebar = document.querySelector('[data-review="sidebar"]');
      const rollover = document.querySelector('[data-review="rollover"]');
      const quota = document.querySelector('[aria-label="Usage limits"][role="region"]');
      const rows = [...(sidebar?.querySelectorAll('[data-slot="sidebar-menu-button"]') ?? [])];
      if (sidebar?.getBoundingClientRect().width !== 344 || rows.length !== expectedRows.length)
        throw new Error(`${state}: sidebar frame or account count changed`);
      rows.forEach((row, index) => {
        const { x, y, width, height } = row.getBoundingClientRect();
        const expected = expectedRows[index]!;
        if (x !== 10 || width !== 323 || y !== expected[0] || height !== expected[1])
          throw new Error(
            `${state}: row ${index} moved: ${JSON.stringify({ x, y, width, height })}`,
          );
      });
      const popup = rollover?.getBoundingClientRect();
      if (popup?.width !== 320 || popup.height !== 429)
        throw new Error(`${state}: rollover changed size`);
      // A section's accessible region role is implicit, so use its tag as fallback.
      const panel = quota ?? document.querySelector('section[aria-label="Usage limits"]');
      if (panel?.getBoundingClientRect().height !== 286)
        throw new Error(`${state}: account quota panel changed height`);
      if (state !== "loading") {
        const pools = panel?.querySelectorAll('[role="group"]');
        if (
          pools?.length !== 2 ||
          [...pools].some((pool) => pool.querySelectorAll('[role="progressbar"]').length !== 2)
        )
          throw new Error(
            `${state}: primary and secondary windows must stay within their two Codex pools`,
          );
        if (panel && panel.scrollHeight > panel.clientHeight)
          throw new Error(`${state}: Codex limits overflow the fixed panel`);
      }
      if (state === "loading" && sidebar?.querySelector('[role="progressbar"][aria-valuenow]'))
        throw new Error("Pending limits must not announce a numeric reading");
      results.push({
        state,
        sidebar: "344px",
        rollover: "320 × 429",
        quotaHeight: 286,
        rows: "stable",
      });
    }
    return results;
  } finally {
    await select("ready");
  }
}
