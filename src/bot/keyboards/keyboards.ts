import { InlineKeyboard } from 'grammy';
import type { Distributor } from '../../types';

/**
 * Builds the inline keyboard for the /distributors list view.
 * Admin users see Add/Edit/Delete buttons; non-admin users see no action buttons.
 */
export function distributorListKeyboard(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (isAdmin) {
    kb.text('➕ Add', 'dist:add')
      .text('✏️ Edit', 'dist:edit_select')
      .text('🗑 Delete', 'dist:delete_select');
  }
  return kb;
}

/**
 * Builds a keyboard listing all distributors as buttons for selection (edit or delete).
 */
export function distributorSelectionKeyboard(
  distributors: Distributor[],
  actionPrefix: 'dist:edit' | 'dist:delete'
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const dist of distributors) {
    kb.text(`${dist.name} (/${dist.alias})`, `${actionPrefix}:${dist.id}`).row();
  }
  kb.text('❌ Cancel', 'dist:cancel');
  return kb;
}

/**
 * Builds a delete confirmation keyboard.
 */
export function deleteConfirmKeyboard(distributorId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Yes, delete', `dist:delete_confirm:${distributorId}`)
    .text('Cancel', 'dist:cancel');
}

/**
 * Builds an inline keyboard for editing a specific distributor's fields.
 */
export function editFieldKeyboard(distributorId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Name', `dist:edit_field:${distributorId}:name`)
    .text('Alias', `dist:edit_field:${distributorId}:alias`)
    .row()
    .text('Bank', `dist:edit_field:${distributorId}:bank`)
    .text('Account', `dist:edit_field:${distributorId}:account`)
    .row()
    .text('Holder', `dist:edit_field:${distributorId}:holder`)
    .row()
    .text('❌ Cancel', 'dist:cancel');
}

/**
 * Builds the "Copy Account Number" button using Telegram's native copy_text.
 */
export function copyAccountKeyboard(accountNumber: string): InlineKeyboard {
  return new InlineKeyboard().copyText('Copy Account Number', accountNumber);
}
