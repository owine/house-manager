'use client';
import { useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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
  const form = useFormContext();
  const { control } = form;

  const schema = metadataSchemaFor(slug);

  // ZodObject has .shape — render one field per key
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;

    return (
      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(shape).map(([key, rawNode]) => {
            const node = unwrap(rawNode as z.ZodTypeAny);
            const label = toLabel(key);
            const fieldName = `metadata.${key}` as const;

            if (node instanceof z.ZodNumber) {
              return (
                <FormField
                  key={key}
                  control={control}
                  name={fieldName}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          className="w-24"
                          step="any"
                          value={field.value ?? ''}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === '' ? undefined : Number(e.target.value),
                            )
                          }
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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
                <FormField
                  key={key}
                  control={control}
                  name={fieldName}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ''}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="— select —" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {opts.map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              );
            }

            if (node instanceof z.ZodBoolean) {
              return (
                <FormField
                  key={key}
                  control={control}
                  name={fieldName}
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="cursor-pointer">{label}</FormLabel>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              );
            }

            // ZodString and fallback → text input
            return (
              <FormField
                key={key}
                control={control}
                name={fieldName}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            );
          })}
        </CardContent>
      </Card>
    );
  }

  // Freeform fallback (ZodRecord / unknown slug) → JSON textarea
  const currentMetadata = form.getValues('metadata');
  const defaultJson =
    currentMetadata && typeof currentMetadata === 'object'
      ? JSON.stringify(currentMetadata, null, 2)
      : typeof currentMetadata === 'string'
        ? currentMetadata
        : '{}';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <FormField
          control={control}
          name="metadata"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Metadata (JSON)</FormLabel>
              <FormControl>
                <Textarea
                  rows={6}
                  defaultValue={defaultJson}
                  className="font-mono"
                  {...field}
                  onChange={(e) => {
                    try {
                      field.onChange(JSON.parse(e.target.value || '{}'));
                    } catch {
                      field.onChange(e.target.value);
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}
