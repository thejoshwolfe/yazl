# yazl

yet another zip library for node

## Output Structure

The Zip File Spec leaves a lot of flexibility up to the zip file creator.
This section explains and justifies yazl's interpretation and decisions regarding this flexibility.

This section is probably not useful to yazl clients,
but may be interesting to unzip implementors and zip file enthusiasts.

### Disk Numbers

All values related to disk numbers are `0`,
because yazl has no multi-disk archive support.

### Version Made By

Always `0x031e`.
This is the value reported by a Linux build of Info-Zip.
Instead of experimenting with different values of this field
to see how different unzip clients would behave,
yazl mimics Info-Zip, which should work everywhere.

Note that the top byte means "UNIX"
and has implications in the External File Attributes.

### Version Needed to Extract

Always `0x0014`.
Without this value, Info-Zip, and possibly other unzip implementations,
refuse to acknowledge General Purpose Bit `8`, which enables utf8 filename encoding.

### General Purpose Bit Flag

Bit `8` is always set.
Filenames are always encoded in utf8, even if the result is indistinguishable from ascii.

Bit `3` is set in the Local File Header.
To support both a streaming input and streaming output api,
it is impossible to know the crc32 before processing the file data.
File Descriptors are given after each file data with this information, as per the spec.
But remember a complete metadata listing is still always available in the central directory record,
so if unzip implementations are relying on that, like they should,
none of this paragraph will matter anyway.

All other bits are unset.

### Internal File Attributes

Always `0`.
The "apparently an ASCII or text file" bit is always unset meaning "apparently binary".
This kind of determination is outside the scope of yazl,
and is probably not significant in any modern unzip implementation.

### External File Attributes

Always `stats.mode << 16`.
This is apparently the convention for "version made by" = `0x03xx` (UNIX).
