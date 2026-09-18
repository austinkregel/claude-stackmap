import { z } from "zod";

/**
 * A type's memory layout, as the `struct_field_list` note schema stores it and `stackmap_get_type`
 * reports it. Offsets and sizes are bytes as JSON numbers; `align` is null when the source can't
 * establish it. A field whose type is itself laid out by value carries that layout in `layout`,
 * recursively. Field names are snake_case, like every new tool's output.
 *
 * A member can be anonymous — an unnamed union or struct, which is how Ghidra and PDBs represent one:
 * its `name` is then null, `anonymous` is true, and its own members are in `layout` at offsets relative
 * to the type that contains it (user decision; the alternative was flattening them into the parent).
 */
export const LayoutFieldSchema = z.strictObject({
  name: z.string().min(1).nullable(),
  anonymous: z.boolean().optional(),
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
