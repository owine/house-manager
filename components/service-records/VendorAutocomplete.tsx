'use client';
import { useEffect, useState } from 'react';
import { useController, useFormContext } from 'react-hook-form';

type Props = {
  name: 'itemId' | 'vendorId';
  label: string;
  options: { id: string; name: string }[];
};

export function VendorAutocomplete({ name, label, options }: Props) {
  const { control } = useFormContext();
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  const initialText = field.value ? (options.find((o) => o.id === field.value)?.name ?? '') : '';

  const [text, setText] = useState(initialText);

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
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor={name} style={{ display: 'block', fontWeight: 500, marginBottom: '0.25rem' }}>
        {label}
      </label>
      <input
        id={name}
        list={listId}
        value={text}
        onChange={handleChange}
        autoComplete="off"
        style={{
          padding: '0.3rem 0.5rem',
          border: '1px solid var(--border-strong)',
          borderRadius: '4px',
          width: '100%',
        }}
        placeholder={`Type to search ${label.toLowerCase()}…`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
      {error?.message && (
        <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginTop: '0.25rem' }}>
          {error.message}
        </p>
      )}
    </div>
  );
}
