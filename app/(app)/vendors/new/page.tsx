import { VendorForm } from '@/components/vendors/VendorForm';
import { createVendor } from '@/lib/vendors/actions';

export default function NewVendorPage() {
  return (
    <div>
      <h1>New vendor</h1>
      <VendorForm action={createVendor} submitLabel="Create vendor" />
    </div>
  );
}
