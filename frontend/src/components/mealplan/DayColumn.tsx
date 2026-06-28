import type { DayPlan } from '../../types/mealPlan';
import MealCard from './MealCard';

interface Props {
  day: DayPlan;
}

const DAY_ABBR: Record<string, string> = {
  Monday: 'MON', Tuesday: 'TUE', Wednesday: 'WED', Thursday: 'THU',
  Friday: 'FRI', Saturday: 'SAT', Sunday: 'SUN',
};

export default function DayColumn({ day }: Props) {
  const date = new Date(day.date + 'T00:00:00');
  const dateNum = date.getDate();
  const month = date.toLocaleString('default', { month: 'short' }).toUpperCase();

  return (
    <div className="day-column">
      <div className="day-column__header">
        <span className="day-column__abbr">{DAY_ABBR[day.day] ?? day.day.slice(0, 3).toUpperCase()}</span>
        <span className="day-column__date">{month} {dateNum}</span>
      </div>
      <div className="day-column__meals">
        {day.meals.map((meal, i) => (
          <MealCard key={i} meal={meal} day={day.day} />
        ))}
      </div>
    </div>
  );
}
