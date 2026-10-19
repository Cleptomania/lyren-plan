// "New board" dialog: name, optional project (→ project board), a template, description.

import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { boardCreateInput } from '@shared/board';
import { LIMITS } from '@shared/constants';
import type { BoardDTO } from '@shared/types';
import { useCreateBoard } from '../../api/boards';
import { useLookups } from '../../api/bootstrap';
import { useSpaceId } from '../../app/space';
import {
  apiFieldErrors,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  zodFieldErrors,
  type FieldErrors,
  type OverlayControls,
} from '../../components/ui';
import { boardHref } from './boardActions';
import { templatesFor, type BoardTemplateId } from './templates';

export interface NewBoardDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fixed project (project Board tab); undefined lets the user choose (null = global). */
  projectId?: number | null;
  /** After creation; default navigates to the new board. */
  onCreated?: (board: BoardDTO) => void;
  /**
   * Awaited before the board is created; a rejection stops the creation and shows its error.
   * The project Board tab uses it to save its still-virtual default board first.
   */
  beforeCreate?: () => Promise<unknown>;
}

export function NewBoardDialog({ open, onClose, projectId: fixedProject, onCreated, beforeCreate }: NewBoardDialogProps) {
  const sid = useSpaceId();
  const uid = useId();
  const lookups = useLookups();
  const navigate = useNavigate();
  const controls = useRef<OverlayControls>(null);
  const create = useCreateBoard();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<number | null>(fixedProject ?? null);
  const [templateId, setTemplateId] = useState<BoardTemplateId>('status');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [preparing, setPreparing] = useState(false);
  const templates = templatesFor(projectId);
  const template = templates.find((t) => t.id === templateId) ?? templates[0]!;
  const project = projectId === null ? undefined : lookups.projectById.get(projectId);

  // Fresh form for every opening.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setProjectId(fixedProject ?? null);
    setTemplateId('status');
    setErrors({});
  }, [open, fixedProject]);

  const submit = async () => {
    if (preparing || create.isPending) return;
    const input = { name: name.trim() || template.name, description: description.trim() || undefined, projectId };
    const parsed = boardCreateInput.safeParse(input);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    if (beforeCreate) {
      setPreparing(true);
      try {
        await beforeCreate();
      } catch (err) {
        toast.error(err);
        return;
      } finally {
        setPreparing(false);
      }
    }
    create.mutate(
      { ...input, config: template.build({ tags: lookups.tags, projectId }) },
      {
        onSuccess: (board) => {
          toast.success(`Created “${board.name}”`);
          // On phones the dialog has its own history entry: pop it before onCreated changes the
          // URL (closeThen), or let the new board's page replace it.
          if (onCreated) {
            if (controls.current) controls.current.closeThen(() => onCreated(board));
            else {
              onClose();
              onCreated(board);
            }
          } else {
            navigate(boardHref(sid, board), { replace: controls.current?.closeForNavigation() ?? false });
          }
        },
        onError: (err) => {
          setErrors(apiFieldErrors(err));
          toast.error(err);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      controlsRef={controls}
      title="New board"
      description={fixedProject && project ? `A board on the Board tab of ${project.name}.` : 'Boards are saved, configurable views over your tasks.'}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending || preparing}>
            Create board
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" htmlFor={`${uid}-name`} error={errors.name} hint={name.trim() ? undefined : `Leave empty to use “${template.name}”.`}>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={LIMITS.boardNameMax}
            placeholder={template.name}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors({});
            }}
          />
        </Field>
        {fixedProject === undefined && (
          <Field
            label="Show tasks of"
            htmlFor={`${uid}-project`}
            error={errors.projectId}
            hint={projectId === null ? 'Listed on the Boards page.' : 'Listed on the project’s Board tab.'}
          >
            <Select
              id={`${uid}-project`}
              value={projectId === null ? '' : String(projectId)}
              onChange={(e) => {
                const next = e.target.value === '' ? null : Number(e.target.value);
                setProjectId(next);
                if (!templatesFor(next).some((t) => t.id === templateId)) setTemplateId('status');
              }}
              options={[
                { value: '', label: 'All projects (global board)' },
                ...lookups.projects.filter((p) => p.status !== 'archived').map((p) => ({ value: String(p.id), label: `${p.name} (${p.key})` })),
              ]}
            />
          </Field>
        )}
        <fieldset className="flex flex-col">
          <legend className="mb-2 text-[13px] font-medium text-fg">Start from</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <label
                key={t.id}
                className={clsx(
                  'relative flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                  templateId === t.id ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-border-strong',
                )}
              >
                <input
                  type="radio"
                  name={`${uid}-template`}
                  value={t.id}
                  checked={templateId === t.id}
                  onChange={() => setTemplateId(t.id)}
                  className="sr-only"
                />
                <span className="text-sm font-medium text-fg">{t.name}</span>
                <span className="text-xs text-fg-muted">{t.description}</span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-fg-muted">Everything can be changed later with Configure.</p>
        </fieldset>
        <Field label="Description" htmlFor={`${uid}-desc`} optional>
          <Textarea id={`${uid}-desc`} autoGrow minRows={2} maxRows={6} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
