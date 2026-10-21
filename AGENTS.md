# Notes for AI assistants working on Phone-Agent

## Owner's rule on pushing (Jamal, 2026-10-21) — read before any push

> "You can push it, as long as I can get the old version back if it ends up not
> being what I'm looking for."

Every AI working here (Claude, DeepSeek, ChatGPT, others) follows this:

1. **Before you push a change, pin the current version**: tag it
   `rollback/YYYY-MM-DD-<what-you-are-changing>` and push the tag too.
2. **Work on a branch.** Merge to `main` only when Jamal says so.
3. **Never force-push. Never delete or move a `rollback/*` or `safety/*` tag.**
4. **Restoring is Jamal's call.** To restore: `git checkout <tag>` to look, or
   `git reset --hard <tag>` on `main` to go back (then restart whatever runs it).
5. Write the new rollback tag into the list below in the same commit.

Rollback points:
- `rollback/2026-10-21-before-phone-control` = `5ac4c24`, the engine before phone commands (`pipe`) and the save lock

**Which repo is which (GitHub ignores capital letters):**
- This repo (`jamallarsen10-hub/Phone-Agent`) = the customer **Follow-up Engine**.
- DeepSeek's **Mac Remote** (`~/Documents/deepseek-harness/default-workspace/phone-agent`) has a
  remote that also says `phone-agent`. It must NOT be pushed here; it belongs in `jamallarsen10-hub/mac-remote`.
