// Clickable <th> that toggles sort direction and shows an arrow when
// active. Used by Products/Customers/Orders/Suppliers list tables.
export default function SortableHeader({ label, field, sortBy, sortDir, onSort, className = '' }) {
  const active = sortBy === field;
  return (
    <th
      onClick={() => onSort(field)}
      className={`py-3 px-2 text-left cursor-pointer select-none hover:bg-gray-200 ${className}`}
    >
      {label}
      {active && <span className="ml-1 text-xs">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}