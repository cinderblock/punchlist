---
name: punchlist
description: Read and update a shared Punchlist, the list of physical jobs for a real space. Use when asked to check, add, update or complete tasks on the punchlist, or to record a physical job that someone needs to do.
---

# Punchlist

Punchlist is a shared list of physical jobs that belongs to a place, not a person.
You reach it through the `punchlist` MCP server. Your token acts as a named agent
owned by one person, and everything you do shows as "<agent name>, for <person>",
including in calendar feeds and notifications. Call `who_am_i` to see who you are
acting for and what your token allows.

## When to ask first

- Ask before creating a **public** task the person didn't request. Public tasks are
  seen by everyone in the space, and can buzz their phones.
- Ask before assigning anyone other than the person you act for.
- Ask before completing a task you didn't do or weren't told is done. A check-off
  tells people that the job is finished.
- Don't ask for routine reads, or for private tasks your person asked for.

## Working with tasks

1. **Search first.** Use `search_tasks` before creating anything. The job may
   already be on the list, or may have been done.
2. **Create with `create_task`.** Use `list_labels`, `list_zones` and `list_people`
   for valid values. Unknown labels are refused; don't invent them. Give a location
   if you know one: `{ zoneId }`, or `{ mapId, x, y }` for a point.
3. **Write for someone standing in the room.** The title says what to do. The details
   say how to tell it's done, and anything they'd need to know first.
4. **Finish with `complete_task`**, with a `note` saying what was done or found.

## Automated tasks

Always set `dedupe_key` on a task that a script, schedule or monitor creates. Use a
stable key for the problem, such as `sensor:back-door:offline`. While a task with
that key is open, creating it again updates it rather than adding a duplicate, and
the result says `deduped: true`. When the problem clears, call `complete_task` with
the same `dedupe_key` and a note; it does nothing if no task is open.

Set `idempotency_key` on any write you might retry.

## What you can't do

Deleting tasks and admin actions aren't available to agents. Private tasks need the
`private:read` and `private:write` scopes, and only reach what your person can see.
If a tool says a scope is missing, tell the person; they can change it under
Settings, then Agents.
