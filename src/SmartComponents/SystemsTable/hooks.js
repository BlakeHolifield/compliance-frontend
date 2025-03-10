import { useEffect, useLayoutEffect, useState } from 'react';
import { useApolloClient, useQuery } from '@apollo/client';
import { useDispatch } from 'react-redux';
import debounce from '@redhat-cloud-services/frontend-components-utilities/debounce';
import { systemsWithRuleObjectsFailed } from 'Utilities/ruleHelpers';
import {
  osMinorVersionFilter,
  GET_MINIMAL_SYSTEMS,
  GET_SYSTEMS_TAGS,
  GET_SYSTEMS_OSES,
} from './constants';
import useExport from 'Utilities/hooks/useTableTools/useExport';
import { useBulkSelect } from 'Utilities/hooks/useTableTools/useBulkSelect';
import { dispatchNotification } from 'Utilities/Dispatcher';

const groupByMajorVersion = (versions = [], showFilter = []) => {
  const showVersion = (version) => {
    if (showFilter.length > 0) {
      return showFilter.map(String).includes(String(version));
    } else {
      return true;
    }
  };

  return versions.reduce((acc, currentValue) => {
    if (showVersion(currentValue.major)) {
      acc[String(currentValue.major)] = [
        ...new Set([...(acc[currentValue.major] || []), currentValue.minor]),
      ];
    }

    return acc;
  }, []);
};

export const useOsMinorVersionFilter = (showFilter, fetchArguments = {}) => {
  let { data } = useQuery(GET_SYSTEMS_OSES, {
    skip: !showFilter,
    ...fetchArguments,
  });
  const { osVersions } = data?.systems || {};

  return showFilter
    ? osMinorVersionFilter(groupByMajorVersion(osVersions, showFilter))
    : [];
};

export const useSystemsFilter = (
  filterString,
  showOnlySystemsWithTestResults,
  defaultFilter
) => {
  const combindedFilter = [
    ...(showOnlySystemsWithTestResults ? ['has_test_results = true'] : []),
    ...(filterString?.length > 0 ? [filterString] : []),
  ].join(' and ');
  const filter = defaultFilter
    ? `(${defaultFilter})` +
      (combindedFilter ? ` and (${combindedFilter})` : '')
    : combindedFilter;

  return filter;
};

const renameInventoryAttributes = ({
  culledTimestamp,
  staleWarningTimestamp,
  staleTimestamp,
  insightsId,
  ...system
}) => ({
  ...system,
  insights_id: insightsId,
  culled_timestamp: culledTimestamp,
  stale_warning_timestamp: staleWarningTimestamp,
  stale_timestamp: staleTimestamp,
});

export const useFetchSystems = ({
  query,
  onComplete,
  variables = {},
  onError,
}) => {
  const client = useApolloClient();

  return (perPage, page, requestVariables = {}) =>
    client
      .query({
        query,
        fetchResults: true,
        fetchPolicy: 'no-cache',
        variables: {
          perPage,
          page,
          ...variables,
          ...requestVariables,
        },
      })
      .then(({ data }) => {
        const systems = data?.systems?.edges?.map((e) => e.node) || [];
        const entities = systemsWithRuleObjectsFailed(systems).map(
          renameInventoryAttributes
        );
        const result = {
          entities,
          meta: {
            ...(requestVariables.tags && { tags: requestVariables.tags }),
            totalCount: data?.systems?.totalCount || 0,
          },
        };

        onComplete && onComplete(result);
        return result;
      })
      .catch((error) => {
        if (onError) {
          onError(error);
          return { entities: [], meta: { totalCount: 0 } };
        } else {
          throw error;
        }
      });
};

const fetchBatched = (fetchFunction, total, filter, batchSize = 50) => {
  const pages = Math.ceil(total / batchSize) || 1;
  return Promise.all(
    [...new Array(pages)].map((_, pageIdx) =>
      fetchFunction(batchSize, pageIdx + 1, filter)
    )
  );
};

const buildApiFilters = (filters = {}) => {
  const { tagFilters, ...otherFilters } = filters;
  const tagsApiFilter = tagFilters
    ? {
        tags: tagFilters.flatMap((tagFilter) =>
          tagFilter.values.map(
            (tag) =>
              `${encodeURIComponent(tagFilter.key)}/${encodeURIComponent(
                tag.tagKey
              )}=${encodeURIComponent(tag.value)}`
          )
        ),
      }
    : {};

  return {
    ...otherFilters,
    ...tagsApiFilter,
  };
};

export const useGetEntities = (fetchEntities, { selected, columns } = {}) => {
  const appendDirection = (attributes, direction) =>
    attributes.map((attribute) => `${attribute}:${direction}`);

  const findColumnByKey = (key) =>
    (columns || []).find((column) => column.key === key);

  return async (
    _ids,
    { page = 1, per_page: perPage, orderBy, orderDirection, filters }
  ) => {
    const sortableColumn = findColumnByKey(orderBy);
    const sortBy =
      sortableColumn && sortableColumn.sortBy
        ? appendDirection(sortableColumn.sortBy, orderDirection)
        : undefined;
    const filterForApi = buildApiFilters(filters);

    const fetchedEntities = await fetchEntities(perPage, page, {
      ...filterForApi,
      sortBy,
    });
    const {
      entities,
      meta: { totalCount },
    } = fetchedEntities || {};

    return {
      results: entities.map((entity) => ({
        ...entity,
        selected: (selected || []).map((id) => id).includes(entity.id),
      })),
      orderBy,
      orderDirection,
      total: totalCount,
    };
  };
};

// This hook is primarily meant to work around issues in the inventory
export const useInventoryUtilities = (
  inventory,
  selectedSystems,
  activeFilters
) => {
  const dispatch = useDispatch();

  // Resets the Inventory to a loading state
  // and prevents previously shown columns and rows to appear
  useLayoutEffect(() => {
    dispatch({
      type: 'INVENTORY_INIT',
    });
  }, []);

  // Ensures rows are marked as selected
  useEffect(() => {
    dispatch({
      type: 'SELECT_ENTITIES',
      payload: {
        selected: selectedSystems,
      },
    });
  }, [selectedSystems]);

  // Filters do not yet trigger the inventory to call getEntities
  // and the page would not reset to page 1
  const resetPage = () => {
    Promise.resolve(
      dispatch({
        type: 'RESET_PAGE',
      })
    ).then(() => inventory?.current?.onRefreshData());
  };

  // The debounce is to not have filter updates collide or get out of order.
  const debounceResetPage = debounce(resetPage, 50);

  useEffect(() => {
    debounceResetPage();
  }, [activeFilters]);
};

const toIdFilter = (ids) =>
  ids?.length > 0 ? `id ^ (${ids.join(',')})` : undefined;

export const useSystemsExport = ({
  columns,
  selected,
  total,
  fetchArguments,
}) => {
  const selectionFilter = selected ? toIdFilter(selected) : undefined;
  const fetchSystems = useFetchSystems({
    query: fetchArguments.query,
    variables: {
      ...fetchArguments.variables,
      ...(fetchArguments.tags && { tags: fetchArguments.tags }),
      filter: selectionFilter
        ? `${fetchArguments.variables.filter} and (${selectionFilter})`
        : fetchArguments.variables.filter,
    },
    onError: () => {
      dispatchNotification({
        variant: 'danger',
        title: 'Couldn’t download export',
        description: 'Reinitiate this export to try again.',
      });
    },
  });

  const selectedFilter = () =>
    selected?.length > 0 ? toIdFilter(selected) : undefined;

  const exporter = async () => {
    const fetchedItems = await fetchBatched(
      fetchSystems,
      total,
      selectedFilter()
    );

    return fetchedItems.flatMap((result) => result.entities);
  };

  const {
    toolbarProps: { exportConfig },
  } = useExport({
    exporter,
    columns,
    isDisabled: total === 0,
    onStart: () => {
      dispatchNotification({
        variant: 'info',
        title: 'Preparing export',
        description: 'Once complete, your download will start automatically.',
      });
    },
    onComplete: () => {
      dispatchNotification({
        variant: 'success',
        title: 'Downloading export',
      });
    },
  });

  return exportConfig;
};

export const useSystemBulkSelect = ({
  total,
  onSelect,
  preselected,
  fetchArguments,
  currentPageIds,
  systemsCache = [],
}) => {
  // This is meant as a compatibility layer and to be removed
  const [selectedSystems, setSelectedSystems] = useState([]);
  const fetchSystems = useFetchSystems({
    ...fetchArguments,
    query: GET_MINIMAL_SYSTEMS,
    onError: (error) => {
      dispatchNotification({
        variant: 'danger',
        title: 'Error selecting systems',
        description: error.message,
      });
    },
  });

  const fetchFunc = async (fetchIds) => {
    if (fetchIds.length === 0) {
      return [];
    }

    const idFilter = toIdFilter(fetchIds);
    const results = await fetchBatched(fetchSystems, fetchIds.length, {
      ...(idFilter && { filter: idFilter }),
    });

    return results.flatMap((result) => result.entities);
  };

  const cachedOrFetch = async (selectedIds) => {
    const cachedSystems = systemsCache.filter(({ id }) =>
      selectedIds.includes(id)
    );
    const cachedIds = cachedSystems.map(({ id }) => id);
    const fetchIds = selectedIds.filter((id) => !cachedIds.includes(id));
    const fetchedSystems = await fetchFunc(fetchIds);

    return [...cachedSystems, ...fetchedSystems];
  };

  const onSelectCallback = async (selectedIds) => {
    const systems = await cachedOrFetch(selectedIds);
    setSelectedSystems(systems);
    onSelect && onSelect(systems);
  };

  const itemIdsInTable = async () => {
    const results = await fetchBatched(fetchSystems, total);
    return results.flatMap((result) => result.entities.map(({ id }) => id));
  };

  const bulkSelect = useBulkSelect({
    total,
    onSelect: onSelectCallback,
    preselected,
    itemIdsInTable,
    itemIdsOnPage: () => currentPageIds,
  });
  return {
    selectedSystems,
    ...bulkSelect,
  };
};

const searchTags = (search, tags) =>
  tags.filter((tagItem) => {
    if (search || search === '') {
      const tagString = `${tagItem?.key}=${tagItem?.value}`;
      return tagString.indexOf(search) !== -1;
    } else {
      return true;
    }
  });

const useFetchTag = () => {
  const apiClient = useApolloClient();

  return async (page, per_page, search, fetchArguments) => {
    const fetchedTags = await apiClient
      .query({
        query: GET_SYSTEMS_TAGS,
        ...fetchArguments,
      })
      .then(
        ({
          data: {
            systems: { tags },
          },
        }) =>
          searchTags(search, tags).map((tag) => ({
            tag,
          }))
      );

    const start = per_page * page - per_page;
    const end = start + per_page;

    return {
      total: fetchedTags.length,
      results: fetchedTags.slice(start, end),
    };
  };
};

export const useTags = (fetchArguments) => {
  const [currentTags, setCurrentTags] = useState();
  const fetchTags = useFetchTag();

  const getTags = async (search, config) => {
    const { page, perPage: per_page } = config.pagination || {
      perPage: 10,
      page: 1,
    };
    const { total, results: tagsList } = await fetchTags(
      page,
      per_page,
      search,
      fetchArguments
    );

    return {
      page,
      per_page,
      total,
      results: tagsList,
    };
  };

  return {
    props: {
      hideFilters: {
        name: true,
        tags: false,
        registeredWith: true,
        operatingSystem: true,
        stale: true,
      },
      showTags: true,
    },
    currentTags,
    setCurrentTags,
    getTags,
  };
};
