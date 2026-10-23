// Read rendered public DOM to calibrate selectors. No form interaction.
import { siteSession } from './site-session.mjs';

await siteSession(process.argv[2], async page => {
  const info = await page.evaluate(() => {
    const text = node => String(node?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      title: document.title,
      bodyHead: text(document.body).slice(0, 900),
      h1: [...document.querySelectorAll('h1')].map(text),
      candidates: [...document.querySelectorAll('[class*="job"],[class*="Job"],[class*="position"],[class*="Position"],[class*="title"],[class*="Title"],[class*="detail"],[class*="Detail"],[class*="desc"],[class*="Desc"]')]
        .filter(node => node.getClientRects().length && getComputedStyle(node).display !== 'none')
        .slice(0, 40).map(node => ({ tag: node.tagName, cls: String(node.className || '').slice(0, 70), text: text(node).slice(0, 100) }))
    };
  });
  return { tool: 'probe', ...info, snapshotEligible: true };
});
