import { Stack } from 'expo-router';

export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="product/[barcode]" options={{ title: 'Product' }} />
      <Stack.Screen name="add-product" options={{ title: 'Add product' }} />
      <Stack.Screen name="review-product/[barcode]" options={{ title: 'Review submission' }} />
      <Stack.Screen name="edit-product/[barcode]" options={{ title: 'Edit product' }} />
      <Stack.Screen name="review-edit/[editId]" options={{ title: 'Review change' }} />
    </Stack>
  );
}
