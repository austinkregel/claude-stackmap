import { z } from "zod";

/**
 * A type's memory layout, as the `struct_field_list` note schema stores it. Offsets and sizes are bytes as JSON numbers;
 * `align` is null when the source can't establish it. A field whose type is itself laid out by value
 * carries that layout in `layout`, recursively. Field names are snake_case, like every new tool's output.
 */
export const LayoutFieldSchema = z.strictObject({
  name: z.string().min(1),
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  type: z.string().min(1),
  bit_offset: z.number().int().nonnegative().optional(),
  bit_size: z.number().int().positive().optional(),
  get layout() {
    return TypeLayoutSchema.optional();
  },
});

export const TypeLayoutSchema = z.strictObject({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  align: z.number().int().positive().nullable(),
  get fields() {
    return z.array(LayoutFieldSchema);
  },
});

export type LayoutField = z.infer<typeof LayoutFieldSchema>;
export type TypeLayout = z.infer<typeof TypeLayoutSchema>;
