CREATE INDEX matching_reverse_lookup ON matching_associations(
 scope,source_owner,source_kind,outcome,json_extract(proof,'$.result.selected')
) WHERE json_valid(proof);
