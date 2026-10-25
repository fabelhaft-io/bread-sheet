import { Stack } from 'expo-router';

export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="product/gtin/[gtin]" options={{ title: 'Looking up…' }} />
      <Stack.Screen name="product/[id]" options={{ title: 'Product' }} />
      <Stack.Screen name="add-product" options={{ title: 'Add product' }} />
      <Stack.Screen name="review-product/[id]" options={{ title: 'Review submission' }} />
      <Stack.Screen name="edit-product/[id]" options={{ title: 'Edit product' }} />
      <Stack.Screen name="review-edit/[editId]" options={{ title: 'Review change' }} />
    </Stack>
  );
}
