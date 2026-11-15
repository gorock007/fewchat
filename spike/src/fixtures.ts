// Synthetic canonical envelope from docs/research/meta-api.md §5.3; never captured data.
export const FAKE_SECRET = "FAKE_SPIKE_SIGNING_SECRET_NOT_VALID";
export const FAKE_PASSWORD = "FAKE_SPIKE_PASSWORD_NOT_FOR_REAL_AUTH";
export const FAKE_SALT = new TextEncoder().encode("FAKE_SALT_16BYTE!");
export const FAKE_HASHES: Record<number, string> = {
  10000: "7c1793478a1d9772c5e7f2c154252b63b64c1ec8e6faf4aecc77fbd75ca89f86",
  25000: "226913425e77c02b10f2b3afb971e52825216a7aa208cd936322e7aa3d673ff3",
  50000: "3a15206a4db8bb992e4e6df8b8448557743fe6eb9cd79fc194683bc196afcb50",
  100000: "fb97a45ec2b32851b6ff278abf1f9cd9750958acb3d5348171b9a4d9325aa881",
};
export const payload = {
  object: "instagram",
  entry: [{
    id: "90000000000000001", time: 1794700801,
    changes: [{ field: "comments", value: {
      id: "90000000000000003",
      from: { id: "90000000000000004", username: "fake_commenter_example" },
      text: "GUIDE please",
      media: { id: "90000000000000002", media_product_type: "REELS" },
    } }],
  }],
};
