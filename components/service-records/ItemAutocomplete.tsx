'use client';
import { useEffect, useState } from 'react';
import { useController, useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';

type Props = {
  name: 'itemId' | 'vendorId';
  label: string;
  options: { id: string; name: string }[];
};

export function ItemAutocomplete({ name, label, options }: Props) {
  const { control } = useFormContext();
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  // Resolve initial display text from RHF value (e.g. prefill from ?itemId=)
  const initialText = field.value ? (options.find((o) => o.id === field.value)?.name ?? '') : '';

  const [text, setText] = useState(initialText);

  // Keep display text in sync when field.value changes externally (e.g. defaultValues hydration)
  useEffect(() => {
    if (field.value) {
      const match = options.find((o) => o.id === field.value);
      if (match) setText(match.name);
    }
  }, [field.value, options]);

  const listId = `${name}-options`;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const typed = e.target.value;
    setText(typed);
    const match = options.find((o) => o.name === typed);
    field.onChange(match ? match.id : undefined);
  }

  return (
    <div className="mb-4">
      {label && (
        <label htmlFor={name} className="mb-1 block text-sm font-medium">
          {label}
        </label>
      )}
      <Input
        id={name}
        list={listId}
        value={text}
        onChange={handleChange}
        autoComplete="off"
        placeholder={label ? `Type to search ${label.toLowerCase()}…` : 'Type to search…'}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
      {error?.message && <p className="mt-1 text-sm text-destructive">{error.message}</p>}
    </div>
  );
}
