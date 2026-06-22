import fc from "fast-check";

/** Random byte array of length between min and max (inclusive). */
export const bytes = (min: number, max: number): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: min, maxLength: max });

/** Random non-empty string up to `maxLength` characters. */
export const shortString = (maxLength = 32): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength });
