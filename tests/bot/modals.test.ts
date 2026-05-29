import { describe, it, expect } from 'vitest';
import { buildCreateMeetingModal, buildChangeActionModal } from '../../src/bot/modals';

describe('buildCreateMeetingModal', () => {
  it('declares the correct callback_id and submit/close labels', () => {
    const view = buildCreateMeetingModal();
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe('create_meeting_modal');
    expect(view.submit.text).toBe('Create');
    expect(view.close.text).toBe('Cancel');
  });

  it('has all six required block_ids', () => {
    const view = buildCreateMeetingModal();
    const ids = view.blocks.map((b: any) => b.block_id);
    expect(ids).toEqual(['title', 'document_url', 'action', 'purpose', 'start_time', 'participants']);
  });

  it('purpose is optional, others are required', () => {
    const view = buildCreateMeetingModal();
    const find = (id: string) => view.blocks.find((b: any) => b.block_id === id);
    expect(find('title').optional).toBeFalsy();
    expect(find('document_url').optional).toBeFalsy();
    expect(find('action').optional).toBeFalsy();
    expect(find('purpose').optional).toBe(true);
    expect(find('start_time').optional).toBeFalsy();
    expect(find('participants').optional).toBeFalsy();
  });

  it('participants uses multi_users_select', () => {
    const view = buildCreateMeetingModal();
    const block = view.blocks.find((b: any) => b.block_id === 'participants');
    expect(block.element.type).toBe('multi_users_select');
  });

  it('start_time uses datetimepicker', () => {
    const view = buildCreateMeetingModal();
    const block = view.blocks.find((b: any) => b.block_id === 'start_time');
    expect(block.element.type).toBe('datetimepicker');
  });

  it('action select has the five document actions', () => {
    const view = buildCreateMeetingModal();
    const block = view.blocks.find((b: any) => b.block_id === 'action');
    const values = block.element.options.map((o: any) => o.value).sort();
    expect(values).toEqual(['approve', 'comment', 'confirm_decision', 'provide_input', 'read']);
  });

  it('purpose is multiline plain_text_input', () => {
    const view = buildCreateMeetingModal();
    const block = view.blocks.find((b: any) => b.block_id === 'purpose');
    expect(block.element.type).toBe('plain_text_input');
    expect(block.element.multiline).toBe(true);
  });
});

describe('buildChangeActionModal', () => {
  it('carries meeting id in private_metadata and preselects current action', () => {
    const view = buildChangeActionModal('meeting-abc', 'comment');
    expect(view.callback_id).toBe('change_action_modal');
    expect(view.private_metadata).toBe('meeting-abc');
    const block = view.blocks.find((b: any) => b.block_id === 'action');
    expect(block.element.type).toBe('static_select');
    expect(block.element.initial_option.value).toBe('comment');
  });

  it('omits initial_option when current action is unknown', () => {
    const view = buildChangeActionModal('m', 'nonexistent');
    const block = view.blocks.find((b: any) => b.block_id === 'action');
    expect(block.element.initial_option).toBeUndefined();
  });
});
