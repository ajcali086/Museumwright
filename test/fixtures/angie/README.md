# The Angie test fixture

A local reconstruction of the Angie page, for `mw pull` in tests: the
sandbox that built `mw` could not reach sheridanwyominghistory.com. It is
not the live page's HTML.

- `article-excerpt.md`: the opening of the pilot's transcript of the post
  (`source/article.md` on the Angie pilot branch), unedited.
- `plate-01.jpg` … `plate-09.jpg`: the pilot's plates, the post's own
  images, in the order the post shows them (plate 9 is used for an image
  with no caption).
- `page.ts` sets the transcript in a blog page with the chrome a real one
  carries (navigation, share bar, an ad, a newsletter box, comments, a
  footer), a lazy image with a srcset, a tracking pixel and a repeated
  image, so extraction is tested against what it must drop.
