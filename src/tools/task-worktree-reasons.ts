// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Receipt reason for a task worktree whose HEAD no longer names its own task branch (F5). */
export const WORKTREE_HEAD_MOVED = "worktree_head_moved";

/** Receipt reason for a merge refused because the source checkout is no longer on a branch that holds the task's base. */
export const WORKTREE_DESTINATION_MOVED = "worktree_destination_moved";

/** Receipt reason for a merge refused because the source checkout already has a Git operation in progress. */
export const WORKTREE_DESTINATION_BUSY = "worktree_destination_busy";

/** Receipt reason for a merge refused because the worktree no longer holds the commit an operator was shown. */
export const WORKTREE_CHANGED_SINCE_PREVIEW = "worktree_changed_since_preview";
