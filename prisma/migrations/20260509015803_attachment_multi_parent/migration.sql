-- Drop the strict exactly-one-parent invariant on attachments. Inbox emails
-- can now be promoted to a service record while keeping the original
-- attachments visible in both contexts (the inbox row + the new SR), instead
-- of forcing a "move" that hides them from the originating email.
--
-- Cascade behavior on each parent FK is unchanged: deleting any parent
-- still cascade-deletes the attachment. For the multi-parent case this
-- means deleting an item that referenced a shared attachment also removes
-- it from the linked service record. The lifecycle in this app's typical
-- usage is dominated by archive (no delete) so the practical impact is
-- small; documented here so a future re-tightening (e.g. SetNull on each
-- parent + at-least-one CHECK) is a deliberate design choice.

ALTER TABLE "attachments" DROP CONSTRAINT "Attachment_exactly_one_parent";
