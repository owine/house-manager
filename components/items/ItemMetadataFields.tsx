'use client';
import { useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/forms/FormField';
import { metadataSchemaFor } from '@/lib/categories';

type Props = { slug: string };

/**
 * Convert a camelCase key to a human-readable label.
 * All-lowercase keys of 2–4 chars (btu, vin, seer) are uppercased entirely.
 */
function toLabel(key: string): string {
  // All-lowercase short keys → uppercase acronym
  if (/^[a-z]{2,4}$/.test(key)) return key.toUpperCase();
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** Unwrap ZodOptional / ZodNullable to reach the inner type. */
function unwrap(node: z.ZodTypeAny): z.ZodTypeAny {
  if (node instanceof z.ZodOptional || node instanceof z.ZodNullable) {
    return unwrap((node as z.ZodOptional<z.ZodTypeAny>)._def.innerType);
  }
  return node;
}

export function ItemMetadataFields({ slug }: Props) {
  const {
    register,
    formState: { errors },
    getValues,
  } = useFormContext();

  const schema = metadataSchemaFor(slug);

  // ZodObject has .shape — render one field per key
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const metaErrors = (errors.metadata ?? {}) as Record<string, { message?: string }>;

    return (
      <fieldset
        style={{
          border: '1px solid var(--border-strong)',
          borderRadius: 4,
          padding: '1rem',
          marginBottom: '1rem',
        }}
      >
        <legend style={{ fontWeight: 600, padding: '0 0.5rem' }}>Metadata</legend>
        {Object.entries(shape).map(([key, rawNode]) => {
          const fieldId = `metadata.${key}`;
          const node = unwrap(rawNode as z.ZodTypeAny);
          const error = metaErrors[key]?.message;
          const label = toLabel(key);

          if (node instanceof z.ZodNumber) {
            return (
              <FormField key={key} label={label} htmlFor={fieldId} error={error}>
                <input
                  id={fieldId}
                  type="number"
                  step="any"
                  {...register(`metadata.${key}`, { valueAsNumber: true })}
                />
              </FormField>
            );
          }

          // ZodEnum: .options is available in both Zod 3 and Zod 4.
          // Zod 4 also has _def.entries (an object); fall back to its keys if needed.
          if (node instanceof z.ZodEnum) {
            // Cast via unknown to avoid version-specific generic shape mismatches.
            const enumAny = node as unknown as {
              options?: string[];
              _def?: { entries?: Record<string, string> };
            };
            const opts: string[] = Array.isArray(enumAny.options)
              ? enumAny.options
              : Object.keys(enumAny._def?.entries ?? {});

            return (
              <FormField key={key} label={label} htmlFor={fieldId} error={error}>
                <select id={fieldId} {...register(`metadata.${key}`)}>
                  <option value="">— select —</option>
                  {opts.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </FormField>
            );
          }

          if (node instanceof z.ZodBoolean) {
            return (
              <FormField key={key} label={label} htmlFor={fieldId} error={error}>
                <input id={fieldId} type="checkbox" {...register(`metadata.${key}`)} />
              </FormField>
            );
          }

          // ZodString and fallback → text input
          return (
            <FormField key={key} label={label} htmlFor={fieldId} error={error}>
              <input id={fieldId} type="text" {...register(`metadata.${key}`)} />
            </FormField>
          );
        })}
      </fieldset>
    );
  }

  // Freeform fallback (ZodRecord / unknown slug) → JSON textarea
  const currentMetadata = getValues('metadata');
  const defaultJson =
    currentMetadata && typeof currentMetadata === 'object'
      ? JSON.stringify(currentMetadata, null, 2)
      : typeof currentMetadata === 'string'
        ? currentMetadata
        : '{}';

  const metaError = (errors.metadata as { message?: string } | undefined)?.message;

  return (
    <fieldset
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 4,
        padding: '1rem',
        marginBottom: '1rem',
      }}
    >
      <legend style={{ fontWeight: 600, padding: '0 0.5rem' }}>Metadata</legend>
      <FormField label="Metadata (JSON)" htmlFor="metadata" error={metaError}>
        <textarea
          id="metadata"
          rows={6}
          defaultValue={defaultJson}
          style={{ fontFamily: 'monospace', width: '100%' }}
          {...register('metadata', {
            setValueAs: (v: string) => {
              try {
                return JSON.parse(v || '{}');
              } catch {
                return v;
              }
            },
          })}
        />
      </FormField>
    </fieldset>
  );
}
