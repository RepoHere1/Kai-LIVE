with open('server.js', 'r') as f:
    content = f.read()

# 1. Remove dryBookPayload function entirely (DRY only)
import re

dry_book_start = content.find('function dryBookPayload() {')
if dry_book_start >= 0:
    # Find the end of this function (next function or module.exports)
    next_func = content.find('\nfunction ', dry_book_start + 1)
    next_async = content.find('\nasync function ', dry_book_start + 1)
    module_exp = content.find('\nmodule.exports', dry_book_start + 1)
    end = len(content)
    for pos in [next_func, next_async, module_exp]:
        if pos >= 0 and pos < end:
            end = pos
    content = content[:dry_book_start] + content[end:]

# 2. Remove dryAccountPayload function (DRY only)
dry_acc_start = content.find('function dryAccountPayload() {')
if dry_acc_start >= 0:
    next_func = content.find('\nfunction ', dry_acc_start + 1)
    next_async = content.find('\nasync function ', dry_acc_start + 1)
    end = len(content)
    for pos in [next_func, next_async]:
        if pos >= 0 and pos < end:
            end = pos
    content = content[:dry_acc_start] + content[end:]

# 3. Replace modePayload to use only liveAccountPayload
mode_start = content.find('async function modePayload(book) {')
if mode_start >= 0:
    next_func = content.find('\nfunction ', mode_start + 1)
    next_async = content.find('\nasync function ', mode_start + 1)
    end = len(content)
    for pos in [next_func, next_async]:
        if pos >= 0 and pos < end:
            end = pos
    new_mode = """async function modePayload(book) {
  let live = null;
  if (book === 'dry') {
    return { mode: 'dry', dry: null, funding: { balance: null }, no_lanes_enabled: !!state.no_lanes_enabled, live_full: null };
  } else {
    live = await liveAccountPayload();
  }
  const b = book || 'dry';
  return {
    mode: b,
    dry: null,
    funding: { balance: live ? live.cash : null },
    no_lanes_enabled: !!state.no_lanes_enabled,
    live_full: live,
  };
}"""
    content = content[:mode_start] + new_mode + content[end:]

# 4. Replace /api/accounts handler to use liveAccountPayload
api_acc_start = content.find("if (p === '/api/accounts') {")
if api_acc_start >= 0:
    next_block = content.find('\n  if (', api_acc_start + 1)
    if next_block == -1:
        next_block = content.find('\n  // ---', api_acc_start + 1)
    if next_block >= 0:
        new_handler = """  // --- accounts
  if (p === '/api/accounts') {
    const book = state.mode || 'live';
    if (book === 'live') {
      (async () => {
        try {
          const live = await liveAccountPayload();
          return json(res, {
            accounts: { live },
            current: 'live',
            provenance: lastProvenance()
          });
        } catch (e) {
          console.error('/api/accounts error:', e.message);
          const live = await liveAccountPayload();
          return json(res, {
            accounts: { live },
            current: 'live',
            provenance: lastProvenance()
          });
        }
      })();
    } else {
      return json(res, { accounts: { live: {} }, current: 'live', provenance: lastProvenance() });
    }
  }"""
        content = content[:api_acc_start] + new_handler + content[next_block:]

with open('server.js', 'w') as f:
    f.write(content)

print("Phase 1 cleanup done")